import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PublicKey } from "@solana/web3.js";
import type { AppConfig } from "../config/config.ts";
import type { Position, TriggerReason } from "../domain/types.ts";
import { listPositions, SOL_MINT } from "../positions/monitor.ts";
import type { PositionPnlMonitor } from "../positions/pnl.ts";
import { fetchTopCareless } from "../market-data/top-careless.ts";
import { getMeta, setMeta } from "../storage/db.ts";
import { notificationCard, notificationSol, notificationPercent, triggerReasonLabel, swapStatusLabel, type NotificationDetail } from "../telegram/presentation.ts";
import type { Notification } from "../telegram/client.ts";
import { cachedTokenInfo, tokenLabel } from "../market-data/token-info.ts";
import { safeError } from "../security.ts";
import { exitReason, fresh, solLamports, swapAllowed } from "./rules.ts";
import { markPaper, type Market, type PaperBin, type Holding } from "./market.ts";

export type PaperPosition = {
  id: string; source_id: string | null; pool: string; mint: string; origin: "manual" | "virtual";
  lower_bin: number; upper_bin: number; bin_step: number; state: "RESERVED" | "OPEN" | "CLOSING" | "CLOSED";
  principal: string | null; adjustment: string; entry_gas: string; rent: string; model: string;
  hold_sol: string | null; hold_token: string | null; profit: string | null; last_at: number | null;
  reason: TriggerReason | "OOR_BELOW_PERCENT" | "OOR_ABOVE_PERCENT" | null; opened_at: number; closed_at: number | null; ignored: number; error: string | null;
};
type Price = { active: number; step: number; solIsX: boolean; at: number };
type Options = {
  db: DatabaseSync; config: AppConfig; market: Market; pnl: PositionPnlMonitor; apiKey?: string;
  discover: () => Promise<boolean>; price: (pool: string) => Price | undefined;
  notify: (message: Notification) => Promise<void>; screening?: typeof fetchTopCareless;
};

export class PaperAutomation {
  private busy = false;
  private stopped = false;
  private lastValuation = 0;
  private lastScreen = 0;
  private pnlResults: Awaited<ReturnType<PositionPnlMonitor["refresh"]>> = new Map();
  constructor(private readonly options: Options) {
    options.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_positions (
        id TEXT PRIMARY KEY, source_id TEXT UNIQUE, origin TEXT NOT NULL, pool TEXT NOT NULL, mint TEXT NOT NULL,
        lower_bin INTEGER NOT NULL, upper_bin INTEGER NOT NULL, bin_step INTEGER NOT NULL, state TEXT NOT NULL,
        principal TEXT, adjustment TEXT NOT NULL DEFAULT '0', entry_gas TEXT NOT NULL DEFAULT '0', rent TEXT NOT NULL DEFAULT '0',
        model TEXT NOT NULL DEFAULT '[]', hold_sol TEXT, hold_token TEXT, profit TEXT, last_at INTEGER,
        reason TEXT, opened_at INTEGER NOT NULL, closed_at INTEGER, ignored INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS automation_virtual_pool ON automation_positions(pool) WHERE origin='virtual' AND state<>'CLOSED';
      CREATE UNIQUE INDEX IF NOT EXISTS automation_virtual_mint ON automation_positions(mint) WHERE origin='virtual' AND state<>'CLOSED';
      CREATE TABLE IF NOT EXISTS automation_blocks (mint TEXT PRIMARY KEY, blocked_at INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_balances (mint TEXT PRIMARY KEY, delta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
    `);
    // A reservation has no ledger debit until OPEN is committed atomically.
    options.db.prepare("DELETE FROM automation_positions WHERE state='RESERVED'").run();
  }

  list(openOnly = true): PaperPosition[] {
    return this.options.db.prepare(`SELECT * FROM automation_positions ${openOnly ? "WHERE state<>'CLOSED'" : ""} ORDER BY opened_at,id`).all() as PaperPosition[];
  }
  manualState(id: string): PaperPosition | undefined {
    return this.options.db.prepare("SELECT * FROM automation_positions WHERE source_id=?").get(id) as PaperPosition | undefined;
  }
  blocks(): Array<{ mint: string }> { return this.options.db.prepare("SELECT mint FROM automation_blocks ORDER BY blocked_at").all() as Array<{ mint: string }>; }
  unblock(mint: string): void {
    new PublicKey(mint);
    if (this.list().some((item) => item.mint === mint && item.state === "CLOSING")) throw new Error("Swap simulasi token ini belum selesai");
    this.options.db.prepare("DELETE FROM automation_blocks WHERE mint=?").run(mint);
    this.event("UNBLOCK", { mint });
  }
  setIgnored(id: string, ignored: boolean): void {
    this.options.db.prepare("UPDATE automation_positions SET ignored=? WHERE id=? AND origin='virtual' AND state='OPEN'").run(ignored ? 1 : 0, id);
  }
  status(): string {
    const real = listPositions(this.options.db).length;
    const virtual = this.list().filter((item) => item.origin === "virtual");
    const pending = this.list().filter((item) => item.state === "CLOSING").length;
    const last = getMeta(this.options.db, "automation_status") ?? "Menunggu siklus pertama";
    const balances = this.options.db.prepare("SELECT delta FROM automation_balances WHERE mint=?").get(SOL_MINT) as { delta: string } | undefined;
    return ["🤖 OTOMATISASI · SIMULASI DRY-RUN", this.options.config.automation.enabled ? "Aktif" : "Nonaktif",
      `Slot ${real + virtual.length}/${this.options.config.automation.max_positions} · nyata ${real} · virtual ${virtual.length}`,
      `Entry ${this.options.config.automation.position_sol} SOL · SPOT SOL saja · bin step ≥${this.options.config.automation.min_bin_step}`,
      `Range ${this.options.config.automation.min_price_percent}%–0% · profit neto ≥${this.options.config.automation.profit_percent}%`,
      `OOR atas ≥${this.options.config.automation.oor_above_bins} bin · bawah ≥${this.options.config.automation.oor_below_bins} bin dari batas range (harga token/SOL)`,
      `Perubahan saldo SOL simulasi ${balances ? Number(balances.delta) / 1e9 : 0} SOL · swap menunggu ${pending}`,
      `Token diblokir ${this.blocks().length}`, ...this.blocks().map((item) => item.mint),
      `Status: ${last}`, "", "Close manual hanya simulasi; posisi nyata tetap memakai slot.",
      "Buka /positions untuk posisi atau /history untuk jurnal simulasi.", "Aktif/nonaktif: /config set automation.enabled true|false",
      "Aktifkan token kembali: /auto unblock <mint>"].join("\n");
  }
  detail(id: string): string {
    const item = this.list(false).find((row) => row.id === id);
    if (!item) return "Posisi simulasi tidak ditemukan.";
    return ["🟡 POSISI VIRTUAL · SPOT SOL", `ID ${item.id}`, `Pool ${item.pool}`, `Token ${item.mint}`,
      `Status ${item.state} · ${item.ignored ? "exit diabaikan" : "exit dipantau"}`,
      `Deposit ${item.principal === null ? "belum tersedia" : Number(item.principal) / 1e9 + " SOL"}`,
      `Range bin ${item.lower_bin}–${item.upper_bin} · step ${item.bin_step}`,
      `Profit neto estimasi ${item.profit === null ? "belum tersedia" : Number(item.profit) / 1e9 + " SOL"}`,
      `Alasan close ${item.reason ?? "—"}`, item.error ?? "", "Estimasi model virtual, tanpa dampak pasar; bukan hasil posisi nyata."].filter(Boolean).join("\n");
  }
  stop(): void { this.stopped = true; }

  private event(type: string, payload: unknown): void {
    this.options.db.prepare("INSERT INTO automation_events(at,type,payload) VALUES(?,?,?)").run(Date.now(), type, JSON.stringify(payload));
  }
  private delta(mint: string): bigint {
    return BigInt((this.options.db.prepare("SELECT delta FROM automation_balances WHERE mint=?").get(mint) as { delta: string } | undefined)?.delta ?? "0");
  }
  private change(mint: string, amount: bigint): void {
    this.options.db.prepare("INSERT INTO automation_balances(mint,delta) VALUES(?,?) ON CONFLICT(mint) DO UPDATE SET delta=excluded.delta")
      .run(mint, (this.delta(mint) + amount).toString());
  }
  private transaction(operation: () => void): void {
    this.options.db.exec("BEGIN IMMEDIATE");
    try { operation(); this.options.db.exec("COMMIT"); } catch (error) { this.options.db.exec("ROLLBACK"); throw error; }
  }
  private active(): boolean {
    return !this.stopped && this.options.config.automation.enabled && this.options.config.mode.dry_run && getMeta(this.options.db, "dry_run") !== "false";
  }
  private availableSlots(): number {
    return this.options.config.automation.max_positions - listPositions(this.options.db).length - this.list().filter((item) => item.origin === "virtual").length;
  }
  private eligible(mint: string, pool: string): boolean {
    return !this.options.config.top_careless.blacklisted_mints.includes(mint) &&
      !this.blocks().some((item) => item.mint === mint) &&
      !listPositions(this.options.db).some((item) => item.tokenMint === mint || item.pool === pool) &&
      !this.list().some((item) => item.mint === mint || item.pool === pool);
  }

  async tick(): Promise<void> {
    if (this.busy || !this.active()) return;
    this.busy = true;
    try {
      const now = Date.now(), full = now - this.lastValuation >= 60_000;
      if (full) this.lastValuation = now;
      const real = listPositions(this.options.db);
      if (full) this.pnlResults = await this.options.pnl.refresh(real.map((item) => item.pool));
      const pnls = this.pnlResults;
      for (const position of real) {
        if (!this.active()) return;
        const previous = this.manualState(position.id);
        if (position.quoteMint !== SOL_MINT || position.ignored || previous?.state === "CLOSED" || previous?.state === "CLOSING") continue;
        const price = this.options.price(position.pool);
        if (!price || !fresh(price.at)) continue;
        const oor = exitReason({ ...price, lower: position.lowerBinId, upper: position.upperBinId, principal: null, profit: null, ignored: false }, this.options.config.automation);
        const result = pnls.get(position.pool), pnl = result?.positions.get(position.id);
        if (!oor && !full) continue;
        try {
          const snapshot = await this.options.market.snapshot(position.pool, position.lowerBinId, position.upperBinId);
          const holding = await this.options.market.holding(position);
          const basisFresh = !result?.error && fresh(result?.fetchedAt ?? 0);
          const principal = basisFresh && pnl?.deposits != null && pnl.deposits > 0 && pnl.withdrawals != null && pnl.claimed != null ? solLamports(pnl.deposits) : null;
          const adjustment = pnl?.withdrawals != null && pnl.claimed != null ? solLamports(pnl.withdrawals + pnl.claimed) : null;
          const gas = this.options.market.gas(position.upperBinId - position.lowerBinId + 1);
          const valuation = oor ? { profit: null } : await this.valuation(holding, position.tokenMint, gas, gas, principal, adjustment);
          const reason = exitReason({ ...snapshot, lower: position.lowerBinId, upper: position.upperBinId,
            principal, profit: valuation.profit, ignored: position.ignored }, this.options.config.automation);
          if (!reason || !this.active() || listPositions(this.options.db).find((item) => item.id === position.id)?.ignored) continue;
          const id = randomUUID();
          this.options.db.prepare(`INSERT INTO automation_positions
            (id,source_id,origin,pool,mint,lower_bin,upper_bin,bin_step,state,principal,adjustment,entry_gas,opened_at)
            VALUES(?,?,'manual',?,?,?,?,?,'OPEN',?,?,?,?)
            ON CONFLICT(source_id) DO UPDATE SET pool=excluded.pool,mint=excluded.mint,lower_bin=excluded.lower_bin,upper_bin=excluded.upper_bin,
              bin_step=excluded.bin_step,principal=excluded.principal,adjustment=excluded.adjustment,entry_gas=excluded.entry_gas
            WHERE automation_positions.state='OPEN'`).run(id, position.id, position.pool, position.tokenMint,
              position.lowerBinId, position.upperBinId, snapshot.step, principal?.toString() ?? null, adjustment?.toString() ?? "0", gas.toString(), now);
          await this.beginClose(this.manualState(position.id)!, holding, reason);
        } catch (error) { await this.failure(position.id, error); }
      }
      for (const item of this.list().filter((row) => row.origin === "virtual" && row.state === "OPEN")) {
        if (!this.active()) return;
        if (item.ignored) continue;
        const price = this.options.price(item.pool);
        if (!full && (!price || !exitReason({ ...price, lower: item.lower_bin, upper: item.upper_bin, principal: null, profit: null, ignored: false }, this.options.config.automation))) continue;
        try {
          const snapshot = await this.options.market.snapshot(item.pool, item.lower_bin, item.upper_bin);
          const holding = markPaper(JSON.parse(item.model) as PaperBin[], snapshot);
          const oor = exitReason({ ...snapshot, lower: item.lower_bin, upper: item.upper_bin, principal: null, profit: null, ignored: false }, this.options.config.automation);
          const valuation = oor ? { profit: null } : await this.valuation(holding, item.mint, BigInt(item.entry_gas), this.options.market.gas(item.upper_bin - item.lower_bin + 1), BigInt(item.principal!), 0n);
          this.options.db.prepare("UPDATE automation_positions SET profit=?,last_at=?,error=NULL WHERE id=? AND state='OPEN'")
            .run(valuation.profit?.toString() ?? null, snapshot.at, item.id);
          const reason = exitReason({ ...snapshot, lower: item.lower_bin, upper: item.upper_bin, principal: BigInt(item.principal!), profit: valuation.profit, ignored: Boolean(item.ignored) }, this.options.config.automation);
          if (reason) await this.beginClose(item, holding, reason);
        } catch (error) { await this.failure(item.id, error); }
      }
      for (const item of this.list().filter((row) => row.state === "CLOSING")) {
        if (!this.active()) return;
        try { await this.finishClose(item); } catch (error) { await this.failure(item.id, error); }
      }
      if (!this.active()) return;
      if (this.availableSlots() <= 0) {
        setMeta(this.options.db, "automation_status", `Entry menunggu slot: ${listPositions(this.options.db).length} posisi nyata; batas ${this.options.config.automation.max_positions}`);
      } else if (Date.now() - this.lastScreen >= 300_000) {
        this.lastScreen = Date.now();
        await this.enter();
      }
    } finally { this.busy = false; }
  }

  private async failure(id: string, error: unknown): Promise<void> {
    const reason = safeError(error);
    this.options.db.prepare("UPDATE automation_positions SET error=? WHERE id=? OR source_id=?").run(reason, id, id);
    this.event("ERROR", { id, reason });
    console.warn("Automation simulation failed:", reason);
    setMeta(this.options.db, "automation_status", reason);
    const item = this.list().find((row) => row.id === id || row.source_id === id);
    if (item?.state === "CLOSING" && !this.options.db.prepare("SELECT 1 FROM automation_events WHERE type='SWAP_WAITING' AND json_extract(payload,'$.id')=? LIMIT 1").get(item.id)) {
      this.event("SWAP_WAITING", { id: item.id });
      await this.notifyPosition("⏳ SWAP SIMULASI TERTUNDA", item, [
        { label: "Status", value: "Close sudah dicatat · swap menunggu" },
        { label: "Detail", value: reason },
        "Yolow akan mencoba swap kembali otomatis, tanpa mengulang close.",
        "Quote yang belum berhasil tidak dihitung sebagai SOL.",
      ]);
    }
  }

  private async notifyPosition(title: string, item: Pick<PaperPosition, "id" | "source_id" | "pool" | "mint">,
    details: NotificationDetail[], final = false, subtitle?: string): Promise<void> {
    try {
      await this.options.notify(notificationCard(title, details, {
        subtitle: subtitle ?? `${tokenLabel(item.mint, cachedTokenInfo(item.mint))} / SOL`,
        mode: "DRY-RUN", timezone: this.options.config.timezone,
        positionId: item.source_id ?? item.id, pool: item.pool, mint: item.mint,
        action: final ? "history" : "auto",
        ...(!final ? { detailCallback: item.source_id ? `position:view:${item.source_id}` : `auto:position:${item.id}` } : {}),
      }));
    } catch (error) { console.warn("Automation notification failed:", safeError(error)); }
  }

  private async valuation(holding: Holding, mint: string, entryGas: bigint, closeGas: bigint, principal: bigint | null, adjustment: bigint | null): Promise<{ profit: bigint | null }> {
    let out = 0n, swapGas = 0n;
    if (holding.token > 0n) {
      const quote = await this.options.market.quote(mint, holding.token);
      if (!fresh(quote.at)) throw new Error("Quote kedaluwarsa");
      if (swapAllowed(quote.valueMicrousd, this.options.config.swap.min_value_usd)) { out = quote.sol; swapGas = quote.gas; }
    }
    return { profit: principal === null || adjustment === null ? null : holding.sol + out + adjustment - principal - entryGas - closeGas - swapGas };
  }

  private async beginClose(item: PaperPosition, holding: Holding, reason: TriggerReason): Promise<void> {
    if (!this.active() || item.ignored) return;
    const gas = this.options.market.gas(item.upper_bin - item.lower_bin + 1);
    const balance = await this.options.market.walletSol();
    if (balance + this.delta(SOL_MINT) < gas) throw new Error("Saldo simulasi tidak cukup untuk gas close");
    if (!this.active() || (item.source_id ? listPositions(this.options.db).find((row) => row.id === item.source_id)?.ignored !== false : this.list().find((row) => row.id === item.id)?.ignored !== 0)) return;
    const rent = holding.rent ?? BigInt(item.rent);
    let transitioned = false;
    this.transaction(() => {
      const changed = this.options.db.prepare("UPDATE automation_positions SET state='CLOSING',hold_sol=?,hold_token=?,rent=?,reason=?,last_at=?,error=NULL WHERE id=? AND state='OPEN'")
        .run(holding.sol.toString(), holding.token.toString(), rent.toString(), reason, Date.now(), item.id).changes;
      if (!changed) return;
      this.change(SOL_MINT, holding.sol + rent - gas);
      this.change(item.mint, holding.token);
      if (reason === "OOR_BELOW_BINS") this.options.db.prepare("INSERT OR IGNORE INTO automation_blocks(mint,blocked_at,reason) VALUES(?,?,?)").run(item.mint, Date.now(), reason);
      this.event("CLOSE_STARTED", { id: item.id, source: item.source_id, reason, closeGas: gas.toString() });
      transitioned = true;
    });
    if (transitioned) await this.notifyPosition("🟡 CLOSE SIMULASI DIMULAI", item, [
      { label: "Alasan", value: triggerReasonLabel(reason) },
      { label: "Asal", value: item.source_id ? "Posisi manual" : "Posisi virtual" },
      ...(reason === "OOR_BELOW_BINS" ? ["Token diblokir sampai diaktifkan manual melalui /auto unblock <mint>.",
        "Setelah loss, simulasi swap mencakup seluruh saldo mint di wallet, termasuk saldo lama."] : []),
      item.source_id ? "Posisi nyata tetap terbuka dan memakai slot." : "Proses hanya mengubah ledger simulasi.",
    ]);
  }

  private async finishClose(item: PaperPosition): Promise<void> {
    // Pending percentage exits retain their original sweep/reentry behavior after restart.
    const loss = item.reason === "OOR_BELOW_BINS" || item.reason === "OOR_BELOW_PERCENT";
    const token = BigInt(item.hold_token!), sol = BigInt(item.hold_sol!);
    const chain = await this.options.market.walletToken(item.mint);
    const available = chain + this.delta(item.mint);
    const amount = loss ? available : token;
    if (amount < 0n || available < amount) throw new Error("Ledger token simulasi perlu rekonsiliasi");
    let received = 0n, swapGas = 0n, status = "SKIPPED_NO_TOKEN";
    if (amount > 0n) {
      const quote = await this.options.market.quote(item.mint, amount);
      if (!fresh(quote.at)) throw new Error("Quote swap kedaluwarsa");
      if (!swapAllowed(quote.valueMicrousd, this.options.config.swap.min_value_usd)) status = "SKIPPED_DUST";
      else { received = quote.sol; swapGas = quote.gas; status = "DRY_RUN_QUOTED"; }
    }
    if (!this.active()) return;
    if (received > 0n && await this.options.market.walletSol() + this.delta(SOL_MINT) < swapGas) throw new Error("Saldo simulasi tidak cukup untuk gas swap");
    if (!this.active()) return;
    const positionOut = amount > 0n ? received * token / amount : 0n;
    const gas = this.options.market.gas(item.upper_bin - item.lower_bin + 1);
    const profit = item.principal === null ? null : sol + positionOut + BigInt(item.adjustment) - BigInt(item.principal) - BigInt(item.entry_gas) - gas - swapGas;
    let completed = false;
    this.transaction(() => {
      const changed = this.options.db.prepare("UPDATE automation_positions SET state='CLOSED',profit=?,closed_at=?,error=NULL WHERE id=? AND state='CLOSING'")
        .run(profit?.toString() ?? null, Date.now(), item.id).changes;
      if (!changed) return;
      if (received > 0n) { this.change(item.mint, -amount); this.change(SOL_MINT, received - swapGas); }
      const journalId = `paper:${item.id}`;
      this.options.db.prepare(`INSERT INTO trade_history
        (mode,position_id,pool,token_mint,bin_step,first_seen_at,opened_at,entry_source,lower_bin,upper_bin,config_snapshot,
         initial_sol_capital,exit_at,trigger_reason,trigger_detail,sol_received,tokens_received,swap_status,swap_sol_received,
         total_sol_returned,pnl_sol,pnl_pct,network_fees_sol,remaining_dust_usd,finalized_at)
        VALUES('dry_run',?,?,?,?,?,?,'automation_paper',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(journalId, item.pool, item.mint, item.bin_step,
          item.opened_at, item.opened_at, item.lower_bin, item.upper_bin, JSON.stringify(this.options.config), item.principal === null ? null : Number(item.principal) / 1e9,
          Date.now(), item.reason, JSON.stringify({ sourcePositionId: item.source_id, model: "shadow liquidity; no market impact", sweepWallet: loss }),
          Number(sol) / 1e9, token.toString(), status, Number(positionOut) / 1e9, Number(sol + positionOut) / 1e9, profit === null ? null : Number(profit) / 1e9,
          profit === null || !item.principal || BigInt(item.principal) === 0n ? null : Number(profit * 1_000_000n / BigInt(item.principal)) / 10_000,
          Number(BigInt(item.entry_gas) + gas + swapGas) / 1e9, null, Date.now());
      this.event("CLOSE_FINAL", { id: item.id, source: item.source_id, reason: item.reason, status,
        walletSweepInput: amount.toString(), positionInput: token.toString(), walletSweepOutput: received.toString(), positionOutput: positionOut.toString() });
      completed = true;
    });
    if (!completed) return;
    if (item.reason === "OOR_ABOVE_BINS" || item.reason === "OOR_ABOVE_PERCENT") setMeta(this.options.db, "automation_preferred_pool", item.pool);
    this.lastScreen = 0;
    const principal = item.principal === null ? null : BigInt(item.principal);
    await this.notifyPosition("🟡 CLOSE SIMULASI SELESAI", item, [
      { label: "Profit neto estimasi", value: `${notificationSol(profit, true)}${profit !== null && principal !== null && principal > 0n ? ` (${notificationPercent(Number(profit) / Number(principal) * 100, true)})` : ""}` },
      { label: "Alasan", value: triggerReasonLabel(item.reason!) },
      { label: "Asal", value: item.source_id ? "Posisi manual" : "Posisi virtual" },
      { label: "Swap", value: swapStatusLabel(status) },
      ...(received > 0n ? [{ label: "SOL swap posisi estimasi", value: notificationSol(positionOut) }] : []),
      ...(status === "SKIPPED_DUST" ? ["Token dust tetap disimpan; tanpa gas swap dan tanpa kredit SOL."] : []),
      ...(loss ? [
        { label: "Hasil saldo lama estimasi", value: notificationSol(received - positionOut) },
        "Saldo token lama tidak dihitung sebagai profit posisi.",
        "Token diblokir sampai diaktifkan manual melalui /auto unblock <mint>.",
      ] : []),
      item.source_id ? "Posisi nyata tetap terbuka dan memakai slot." : "Saldo hanya berubah pada ledger simulasi.",
    ], true);
  }

  private async enter(): Promise<void> {
    if (!(await this.options.discover()) || !this.active() || this.availableSlots() <= 0) return;
    const blocked = new Set([...this.options.config.top_careless.blacklisted_mints, ...this.blocks().map((item) => item.mint), ...listPositions(this.options.db).map((item) => item.tokenMint), ...this.list().map((item) => item.mint)]);
    const screenAt = Date.now();
    const result = await (this.options.screening ?? fetchTopCareless)({ ...this.options.config.top_careless,
      min_market_cap_usd: Math.max(1_500_000, this.options.config.top_careless.min_market_cap_usd),
      min_token_age_days: Math.max(3, this.options.config.top_careless.min_token_age_days),
      min_tvl_usd: Math.max(5_000, this.options.config.top_careless.min_tvl_usd), limit: 2000 }, this.options.apiKey ?? "",
      this.options.config.candles.providers.meteora?.base_url ?? "https://dlmm.datapi.meteora.ag", this.options.config.jupiter.tokens_base_url,
      { excludedMints: blocked, minBinStep: this.options.config.automation.min_bin_step });
    const preferredPool = getMeta(this.options.db, "automation_preferred_pool");
    const candidates = preferredPool ? [...result.pools.filter((pool) => pool.address === preferredPool), ...result.pools.filter((pool) => pool.address !== preferredPool)] : result.pools;
    setMeta(this.options.db, "automation_preferred_pool", "");
    const amount = solLamports(this.options.config.automation.position_sol);
    for (const pool of candidates) {
      if (!this.active() || this.availableSlots() <= 0) break;
      if (!this.eligible(pool.mint, pool.address)) continue;
      const id = randomUUID();
      try {
        this.transaction(() => {
          if (this.availableSlots() <= 0 || !this.eligible(pool.mint, pool.address)) throw new Error("Slot atau token telah terpakai");
          this.options.db.prepare(`INSERT INTO automation_positions(id,origin,pool,mint,lower_bin,upper_bin,bin_step,state,opened_at)
            VALUES(?,'virtual',?,?,0,0,?,'RESERVED',?)`).run(id, pool.address, pool.mint, pool.binStep, Date.now());
        });
        const plan = await this.options.market.entry(pool.address, amount);
        if (!fresh(plan.snapshot.at) || plan.snapshot.mint !== pool.mint || plan.snapshot.step < this.options.config.automation.min_bin_step || !this.active()) throw new Error("Validasi entry berubah");
        if (!(await this.options.discover())) throw new Error("Discovery entry belum berhasil");
        const balance = await this.options.market.walletSol();
        this.transaction(() => {
          if (!fresh(screenAt) || !fresh(plan.snapshot.at) || !this.active() || this.availableSlots() < 0 || listPositions(this.options.db).some((item) => item.tokenMint === pool.mint || item.pool === pool.address) ||
              this.options.config.top_careless.blacklisted_mints.includes(pool.mint) || this.blocks().some((item) => item.mint === pool.mint)) throw new Error("Entry tidak lagi memenuhi syarat");
          if (balance + this.delta(SOL_MINT) < amount + plan.rent + plan.gas) throw new Error("Saldo simulasi tidak cukup untuk deposit, rent dan gas");
          this.change(SOL_MINT, -(amount + plan.rent + plan.gas));
          this.options.db.prepare("UPDATE automation_positions SET state='OPEN',lower_bin=?,upper_bin=?,principal=?,entry_gas=?,rent=?,model=?,last_at=? WHERE id=?")
            .run(plan.lower, plan.upper, amount.toString(), plan.gas.toString(), plan.rent.toString(), JSON.stringify(plan.model), plan.snapshot.at, id);
          this.event("ENTRY", { id, pool: pool.address, mint: pool.mint, amount: amount.toString(), rent: plan.rent.toString(), gas: plan.gas.toString(), nonRefundable: "0" });
        });
        await this.notifyPosition("🟡 ENTRY VIRTUAL · SPOT SOL", { id, source_id: null, pool: pool.address, mint: pool.mint }, [
          { label: "Modal", value: notificationSol(amount) },
          { label: "Strategi", value: "SPOT · SOL saja" },
          { label: "Bin step", value: String(plan.snapshot.step) },
          { label: "Range harga", value: `${notificationPercent(this.options.config.automation.min_price_percent)} hingga 0,00%` },
          { label: "Range bin", value: `${plan.lower}–${plan.upper}` },
          { label: "Non-refundable", value: notificationSol(0n) },
          { label: "Rent refundable", value: notificationSol(plan.rent) },
          { label: "Gas entry estimasi", value: notificationSol(plan.gas) },
          "Tidak ada transaksi yang ditandatangani atau dikirim.",
        ], false, `${pool.symbol}/SOL`);
      } catch (error) {
        this.options.db.prepare("DELETE FROM automation_positions WHERE id=? AND state='RESERVED'").run(id);
        const reason = safeError(error);
        this.event("ENTRY_SKIPPED", { pool: pool.address, mint: pool.mint, reason });
        setMeta(this.options.db, "automation_status", reason);
      }
    }
    setMeta(this.options.db, "automation_last_scan", String(Date.now()));
  }
}
