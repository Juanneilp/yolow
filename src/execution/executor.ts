import DLMM from "../meteora.ts";
import { jupiterTransactionInstructions, validateJupiterSource, validateJupiterWritableAccounts, type JupiterBuild } from "./jupiter.ts";
export { jupiterTransactionInstructions } from "./jupiter.ts";
import BN from "bn.js";
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Keypair, PublicKey,
  TransactionMessage, VersionedTransaction,
  type Connection, type Transaction,
} from "@solana/web3.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AppConfig } from "../config/config.ts";
import type { Position, Trigger } from "../domain/types.ts";
import { exitReason } from "../automation/rules.ts";
import type { DatabaseSync } from "node:sqlite";
import { getMeta, setMeta } from "../storage/db.ts";
import { discoverPositions, listPositions } from "../positions/monitor.ts";
import { persistTradeCsv } from "../journal/export.ts";
import { join } from "node:path";
import { readJsonResponse, safeError } from "../security.ts";
import { notificationCard, triggerReasonLabel, notificationSol, notificationPercent, type NotificationDetail } from "../telegram/presentation.ts";

import type { Notification } from "../telegram/client.ts";
import { cachedTokenInfo, tokenLabel } from "../market-data/token-info.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";

class SkipClose extends Error {
  constructor(message: string, readonly outcome: string) { super(message); }
}

class UnknownBroadcast extends Error {}

class MetadataPending extends Error {}

export function formatExitTimestamp(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).format(new Date(epoch));
}

type Options = {
  connection: Connection;
  db: DatabaseSync;
  config: AppConfig;
  wallet: PublicKey;
  jupiterApiKey?: string;
  notify: (message: Notification) => Promise<void>;
  keypairPath?: string;
  keypair?: Keypair;
};

export async function loadSigner(path: string, wallet: PublicKey): Promise<Keypair> {
  const resolvedPath = await realpath(resolve(path));
  const relativePath = relative(await realpath(process.cwd()), resolvedPath);
  if (relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) {
    throw new Error("AGENT_KEYPAIR_PATH harus berada di luar repository");
  }
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile() || fileStat.size > 4_096) throw new Error("File keypair harus berupa file kecil yang valid");
  if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) throw new Error("File keypair harus dimiliki user yang menjalankan Yolow");
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) throw new Error("Izin file keypair terlalu terbuka; gunakan chmod 600");
  const secret = JSON.parse(await readFile(resolvedPath, "utf8"));
  if (!Array.isArray(secret) || secret.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("File keypair harus berupa array byte Solana");
  const signer = Keypair.fromSecretKey(new Uint8Array(secret));
  if (!signer.publicKey.equals(wallet)) throw new Error("Public key keypair tidak cocok dengan AGENT_WALLET_PUBKEY");
  return signer;
}

export async function simulateLegacyTransaction(connection: Connection, tx: Transaction): Promise<number | undefined> {
  // SDK Meteora mengembalikan legacy Transaction. Pada @solana/web3.js 1.98.4,
  // simulateTransaction(legacyTx, { config }) melempar "Invalid arguments" secara sinkron,
  // sehingga simulasi harus dipanggil tanpa argumen kedua (commitment mengikuti Connection).
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) throw new Error(`Simulasi gagal: ${JSON.stringify(simulation.value.err)}`);
  return simulation.value.unitsConsumed;
}

export class CloseExecutor {
  private readonly inFlight = new Set<string>();
  private readonly swapsInFlight = new Set<string>();
  private signer?: Keypair;

  constructor(private readonly options: Options) { this.signer = options.keypair; }

  private card(title: string, details: NotificationDetail[]) {
    const id = details.find((item) => typeof item !== "string" && item.label === "Posisi");
    const position = id && typeof id !== "string" ? listPositions(this.options.db, false).find((item) => item.id === id.value) : undefined;
    const shownDetails = position ? details.filter((item) => typeof item === "string" || item.label !== "Pool") : details;
    return notificationCard(title, shownDetails, { mode: this.isDryRun() ? "DRY-RUN" : "LIVE", timezone: this.options.config.timezone,
      ...(position ? { subtitle: tokenLabel(position.tokenMint, cachedTokenInfo(position.tokenMint)) + (position.quoteMint === SOL_MINT ? " / SOL" : ""), pool: position.pool } : {}),
      action: "history" });
  }

  private async notify(message: Notification): Promise<void> {
    try { await this.options.notify(message); }
    catch (error) { console.warn("Execution notification failed:", safeError(error)); }
  }

  setSigner(signer: Keypair): void { this.signer = signer; }

  isDryRun(): boolean {
    const stored = getMeta(this.options.db, "dry_run");
    return stored === undefined ? this.options.config.mode.dry_run : stored !== "false";
  }

  async reconcileTransactions(): Promise<void> {
    const unresolved = this.options.db.prepare("SELECT signature,kind FROM transactions WHERE status IN ('PENDING','UNKNOWN')")
      .all() as Array<{ signature: string; kind: string }>;
    for (const transaction of unresolved) {
      const status = await this.options.connection.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true }).catch(() => null);
      const chain = status?.value[0];
      if (chain && (chain.confirmationStatus === "confirmed" || chain.confirmationStatus === "finalized") && chain.err === null) {
        this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=COALESCE(confirmed_at,?) WHERE signature=?")
          .run(Date.now(), transaction.signature);
      } else if (chain?.err) {
        this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=COALESCE(confirmed_at,?) WHERE signature=?")
          .run(JSON.stringify(chain.err), Date.now(), transaction.signature);
        if (transaction.kind === "SWAP") this.options.db.prepare("UPDATE swaps SET status='FAILED',error=?,updated_at=? WHERE signature=?")
          .run(JSON.stringify(chain.err), Date.now(), transaction.signature);
      } else {
        this.options.db.prepare("UPDATE transactions SET status='UNKNOWN' WHERE signature=?").run(transaction.signature);
      }
    }

    const swaps = this.options.db.prepare(`SELECT t.signature,t.position_id FROM transactions t
      WHERE t.kind='SWAP' AND t.status='CONFIRMED'`).all() as Array<{ signature: string; position_id: string }>;
    for (const swap of swaps) {
      try { await this.reconcileSwap(swap.signature, swap.position_id); }
      catch (error) {
        if (!(error instanceof MetadataPending)) throw error;
        await this.deferMetadata(swap.position_id, safeError(error));
      }
    }

    await discoverPositions(this.options.connection, this.options.wallet, this.options.db);
    const closed = listPositions(this.options.db, false).filter((position) => position.state === "CLOSED");
    for (const position of closed) {
      try { await this.reconcileClose(position); }
      catch (error) {
        if (!(error instanceof MetadataPending)) throw error;
        await this.deferMetadata(position.id, safeError(error));
      }
    }
  }

  private async reconcileSwap(signature: string, positionId: string): Promise<void> {
    const swap = this.options.db.prepare("SELECT sol_received_lamports FROM swaps WHERE signature=?").get(signature) as { sol_received_lamports: string | null } | undefined;
    if (!swap) throw new MetadataPending(`Catatan input swap ${signature} belum tersedia; retry ditolak`);
    if (swap.sol_received_lamports !== null) return;
    this.options.db.prepare("UPDATE swaps SET status='CONFIRMED',updated_at=? WHERE signature=?").run(Date.now(), signature);
    this.recordSwap(signature, positionId, await this.transactionDeltas(signature, SOL_MINT));
  }

  private recordSwap(signature: string, positionId: string, deltas: { solDelta: bigint; feeLamports: bigint }): void {
    const db = this.options.db;
    const swap = db.prepare("SELECT * FROM swaps WHERE signature=?").get(signature) as Record<string, any>;
    if (swap.sol_received_lamports !== null) return;
    const previous = db.prepare(`SELECT signature,MAX(sol_received_lamports) AS amount FROM swaps
      WHERE position_id=? AND status='CONFIRMED' AND sol_received_lamports IS NOT NULL AND signature<>? GROUP BY signature`)
      .all(positionId, signature) as Array<{ amount: string }>;
    const total = previous.reduce((sum, row) => sum + BigInt(row.amount), deltas.solDelta);
    const quote = Number(swap.quoted_sol_lamports ?? 0);
    const slippage = quote > 0 ? (quote - Number(deltas.solDelta)) / quote * 10_000 : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE swaps SET status='CONFIRMED',sol_received_lamports=?,updated_at=? WHERE signature=?")
        .run(deltas.solDelta.toString(), Date.now(), signature);
      db.prepare(`UPDATE trade_history SET swap_status='CONFIRMED',swap_signature=?,swap_input_mint=?,swap_sol_received=?,
        swap_slippage=?,swap_price_impact=?,total_sol_returned=COALESCE(sol_received,0)+?,
        network_fees_sol=COALESCE(network_fees_sol,0)+?,finalized_at=? WHERE position_id=?`)
        .run(signature, swap.input_mint, Number(total) / 1e9, slippage, swap.price_impact,
          Number(total) / 1e9, Number(deltas.feeLamports) / 1e9, Date.now(), positionId);
      db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'SWAP_CONFIRMED',? FROM trade_history WHERE position_id=?")
        .run(Date.now(), JSON.stringify({ signature, receivedLamports: deltas.solDelta.toString() }), positionId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    this.updatePnl(positionId);
  }

  private async reconcileClose(position: Position): Promise<void> {
    let trade = this.options.db.prepare("SELECT * FROM trade_history WHERE position_id=?")
      .get(position.id) as Record<string, any> | undefined;
    if (trade?.mode === "dry_run" && this.options.db.prepare("SELECT 1 FROM transactions WHERE position_id=? AND kind='CLOSE' AND status='CONFIRMED'").get(position.id)) {
      this.promoteTrade(position.id);
      trade = this.options.db.prepare("SELECT * FROM trade_history WHERE position_id=?").get(position.id) as Record<string, any>;
    }
    if (!trade || trade.finalized_at !== null) return;
    const swapMetadataPending = this.options.db.prepare(`SELECT 1 FROM transactions t
      WHERE t.position_id=? AND t.kind='SWAP' AND t.status='CONFIRMED'
      AND NOT EXISTS (SELECT 1 FROM swaps s WHERE s.signature=t.signature AND s.sol_received_lamports IS NOT NULL) LIMIT 1`)
      .get(position.id);
    if (swapMetadataPending) return;
    const unsettled = this.options.db.prepare("SELECT 1 AS present FROM transactions WHERE position_id=? AND kind='CLOSE' AND status IN ('PENDING','UNKNOWN') LIMIT 1")
      .get(position.id);
    if (unsettled) return;
    let result = this.options.db.prepare("SELECT * FROM close_results WHERE position_id=? AND status='CONFIRMED' ORDER BY created_at DESC LIMIT 1")
      .get(position.id) as Record<string, any> | undefined;
    if (!result) {
      const txs = this.options.db.prepare(`SELECT signature,confirmed_at FROM transactions
        WHERE position_id=? AND kind='CLOSE' AND status='CONFIRMED' ORDER BY confirmed_at`).all(position.id) as Array<{ signature: string; confirmed_at: number | null }>;
      if (!txs.length) return;
      let token = 0n;
      let solAmount = 0n;
      let fees = 0n;
      for (const tx of txs) {
        const delta = await this.transactionDeltas(tx.signature, position.tokenMint);
        token += delta.tokenDelta;
        solAmount += delta.solDelta;
        fees += delta.feeLamports;
      }
      const trigger = this.recoveredTrigger(trade.trade_id, txs.at(-1)!.signature);
      const triggerRow = this.options.db.prepare("SELECT id FROM triggers WHERE position_id=? ORDER BY id DESC LIMIT 1")
        .get(position.id) as { id: number } | undefined;
      const signature = txs.at(-1)!.signature;
      this.options.db.prepare(`INSERT INTO close_results(position_id,trigger_id,token_mint,token_received,sol_received_lamports,signature,mode,status,created_at)
        VALUES(?,?,?,?,?,?,'live','CONFIRMED',?)`).run(position.id, triggerRow?.id ?? null, position.tokenMint,
        token.toString(), solAmount.toString(), signature, Date.now());
      const closedAt = txs.at(-1)!.confirmed_at ?? Date.now();
      const metrics = this.positionMetrics(position.id, closedAt);
      this.options.db.prepare(`UPDATE trade_history SET exit_at=?,trigger_reason=?,trigger_detail=?,close_signature=?,sol_received=?,tokens_received=?,
        network_fees_sol=?,duration_sec=?,time_in_range_pct=?,mfe_sol=?,mae_sol=?,max_drawdown_pct=?,max_active_bin=?,min_active_bin=?,range_exit_count=?,
        total_sol_returned=?,finalized_at=NULL WHERE position_id=?`)
        .run(closedAt, trigger?.reason ?? "LEGACY_RECOVERY", trigger ? JSON.stringify(trigger.detail) : "{}", signature,
          Number(solAmount) / 1e9, token.toString(), Number(fees) / 1e9, metrics.duration, metrics.inRangePct,
          metrics.mfe, metrics.mae, metrics.maxDrawdown, metrics.maxActiveBin, metrics.minActiveBin,
          metrics.rangeExits, Number(solAmount) / 1e9, position.id);
      result = { position_id: position.id, token_received: token.toString(), sol_received_lamports: solAmount.toString(), signature, created_at: closedAt };
    }
    setMeta(this.options.db, "close_failures", "0");
    setMeta(this.options.db, "close_failures_at", "0");
    if (trade.exit_at == null) {
      const trigger = this.recoveredTrigger(trade.trade_id, result.signature);
      const closedAt = Number(result.created_at ?? Date.now());
      const solAmount = Number(BigInt(result.sol_received_lamports ?? "0")) / 1e9;
      const tokenAmount = BigInt(result.token_received ?? "0");
      const metrics = this.positionMetrics(position.id, closedAt);
      const detail = trigger ? JSON.stringify(trigger.detail) : "{}";
      const exitPrice = trigger?.detail.unit === "usd" && typeof trigger.detail.close === "number"
        ? trigger.detail.close : null;
      this.options.db.prepare(`UPDATE trade_history SET exit_at=?,trigger_reason=?,trigger_detail=?,close_signature=?,sol_received=?,tokens_received=?,
        exit_price_usd=?,network_fees_sol=COALESCE(network_fees_sol,0),duration_sec=?,time_in_range_pct=?,mfe_sol=?,mae_sol=?,max_drawdown_pct=?,
        max_active_bin=?,min_active_bin=?,range_exit_count=?,total_sol_returned=? WHERE position_id=?`)
        .run(closedAt, trigger?.reason ?? "LEGACY_RECOVERY", detail, result.signature, solAmount, tokenAmount.toString(), exitPrice,
          metrics.duration, metrics.inRangePct, metrics.mfe, metrics.mae, metrics.maxDrawdown, metrics.maxActiveBin,
          metrics.minActiveBin, metrics.rangeExits, solAmount, position.id);
      const tradeId = trade.trade_id as number;
      const offsets = this.options.config.history.post_exit_marks_min as number[];
      const priceAvailable = exitPrice !== null;
      const saveMark = this.options.db.prepare(`INSERT OR IGNORE INTO post_exit_marks(trade_id,offset_min,due_at,status,reason)
        VALUES(?,?,?, ?,?)`);
      for (const offset of offsets) saveMark.run(tradeId, offset, closedAt + offset * 60_000,
        priceAvailable ? "PENDING" : "UNAVAILABLE", priceAvailable ? null : "exit price in USD unavailable");
      this.updatePnl(position.id);
    }
    const tokens = BigInt(result.token_received ?? 0);
    if (!this.options.config.swap.enabled || tokens <= 0n) {
      this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
        .run(this.options.config.swap.enabled ? "SKIPPED_NO_TOKEN" : "SKIPPED_DISABLED", Date.now(), position.id);
      this.updatePnl(position.id);
    } else {
      const previousSwap = this.options.db.prepare("SELECT status FROM swaps WHERE position_id=? AND close_signature=? ORDER BY id DESC LIMIT 1")
        .get(position.id, result.signature) as { status: string } | undefined;
      if (previousSwap && ["PENDING", "UNKNOWN"].includes(previousSwap.status)) return;
      if (!previousSwap) {
        if (this.isDryRun()) return;
        await this.finishSwap(position, tokens, false, result.signature ?? undefined);
      }
      else {
        this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
          .run(previousSwap.status, Date.now(), position.id);
        this.updatePnl(position.id);
      }
    }
    await this.exportCsv();
    await this.notify(this.card("🔄 JOURNAL POSISI DIPULIHKAN", [
      { label: "Posisi", value: position.id, code: true },
      "Yolow menemukan transaksi close terkonfirmasi di blockchain dan memulihkan catatan trade.",
      `Signature https://solscan.io/tx/${result.signature}`,
    ]));
  }

  private recoveredTrigger(tradeId: number, signature: string): Trigger | undefined {
    const rows = this.options.db.prepare("SELECT payload FROM trade_events WHERE trade_id=? AND type IN ('CLOSE_SENT','CLOSE_PREPARED') ORDER BY at DESC")
      .all(tradeId) as Array<{ payload: string }>;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as { signature?: string; trigger?: Trigger };
        if (payload.signature === signature && payload.trigger) return payload.trigger;
      } catch { /* ignore malformed historical event */ }
    }
    const fallback = this.options.db.prepare(`SELECT pool,reason,detected_at,confirmed_at,detail FROM triggers
      WHERE position_id=(SELECT position_id FROM trade_history WHERE trade_id=?) ORDER BY id DESC LIMIT 1`)
      .get(tradeId) as { pool: string; reason: Trigger["reason"]; detected_at: number; confirmed_at: number; detail: string } | undefined;
    if (!fallback) return undefined;
    return { positionId: (this.options.db.prepare("SELECT position_id FROM trade_history WHERE trade_id=?").get(tradeId) as { position_id: string }).position_id,
      pool: fallback.pool, reason: fallback.reason, detectedAt: fallback.detected_at, confirmedAt: fallback.confirmed_at, detail: JSON.parse(fallback.detail) };
  }

  private assertFreshTrigger(trigger: Trigger): void {
    if (!["TAKE_PROFIT", "OOR_BELOW_BINS", "OOR_ABOVE_BINS"].includes(trigger.reason)) throw new SkipClose("Strategi exit lama sudah dihapus", "RETIRED_TRIGGER");
    const at = Number(trigger.detail.snapshotAt);
    if (!Number.isSafeInteger(at) || at > Date.now() || Date.now() - at > 120_000) throw new SkipClose("Data harga/PnL kedaluwarsa", "STALE_PRICE");
  }

  private promoteTrade(positionId: string): void {
    const db = this.options.db;
    const trade = db.prepare("SELECT * FROM trade_history WHERE position_id=?").get(positionId) as Record<string, any> | undefined;
    if (trade?.mode !== "dry_run") return;
    const candles = db.prepare("SELECT * FROM trade_candles WHERE trade_id=?").all(trade.trade_id);
    const marks = db.prepare("SELECT * FROM post_exit_marks WHERE trade_id=?").all(trade.trade_id);
    const clear = Object.keys(trade).filter((key) => key.startsWith("exit_") || key.startsWith("swap_") ||
      ["trigger_reason", "trigger_detail", "close_signature", "sol_received", "tokens_received", "network_fees_sol",
        "remaining_dust_usd", "total_sol_returned", "pnl_sol", "pnl_pct", "pnl_usd", "pnl_reason", "duration_sec",
        "time_in_range_pct", "mfe_sol", "mae_sol", "max_drawdown_pct", "max_active_bin", "min_active_bin", "range_exit_count", "finalized_at"].includes(key));
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) VALUES(?,?,'DRY_RUN_ARCHIVED',?)")
        .run(trade.trade_id, Date.now(), JSON.stringify({ trade, candles, marks }));
      db.prepare(`UPDATE trade_history SET mode='live',${clear.map((key) => `${key}=NULL`).join(",")} WHERE position_id=?`).run(positionId);
      db.prepare("DELETE FROM trade_candles WHERE trade_id=?").run(trade.trade_id);
      db.prepare("DELETE FROM post_exit_marks WHERE trade_id=?").run(trade.trade_id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private async deferMetadata(positionId: string, reason: string): Promise<void> {
    const db = this.options.db;
    const previous = db.prepare("SELECT swap_status FROM trade_history WHERE position_id=?").get(positionId) as { swap_status: string } | undefined;
    db.prepare("UPDATE trade_history SET swap_status='WAITING_METADATA',finalized_at=NULL WHERE position_id=?").run(positionId);
    if (previous?.swap_status === "WAITING_METADATA") return;
    db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'METADATA_PENDING',? FROM trade_history WHERE position_id=?")
      .run(Date.now(), JSON.stringify({ reason }), positionId);
    await this.notify(this.card("⏳ MENUNGGU METADATA TRANSAKSI", [
      { label: "Posisi", value: positionId, code: true }, reason, "Signature tetap tersimpan. Yolow akan membaca ulang hasil tanpa mengirim ulang transaksi.",
    ]));
  }

  async retrySwap(positionId: string): Promise<void> {
    if (this.swapsInFlight.has(positionId)) throw new Error("Swap untuk posisi ini sedang berjalan.");
    const latest = this.options.db.prepare("SELECT status,close_signature FROM swaps WHERE position_id=? ORDER BY id DESC LIMIT 1")
      .get(positionId) as { status: string; close_signature: string | null } | undefined;
    if (!latest || !["NO_ROUTE", "FAILED"].includes(latest.status)) throw new Error("Percobaan swap terbaru bukan NO_ROUTE/FAILED; retry ditolak.");
    if (!this.options.config.swap.enabled) throw new Error("swap.enabled sedang nonaktif.");
    if (!this.isDryRun() && !this.signer) throw new Error("Live mode memerlukan signer yang valid.");
    const position = listPositions(this.options.db, false).find((item) => item.id === positionId);
    if (!position) throw new Error("Posisi tidak ditemukan di journal.");
    if (!latest.close_signature) throw new Error("Retry memerlukan hasil close live terkonfirmasi.");
    await this.finishSwap(position, 0n, this.isDryRun(), latest.close_signature, true);
  }

  private async remainingSwapAmount(position: Position, closeSignature: string): Promise<bigint> {
    const unresolved = this.options.db.prepare(`SELECT 1 FROM transactions WHERE position_id=? AND status IN ('PENDING','UNKNOWN')
      UNION ALL SELECT 1 FROM swaps WHERE position_id=? AND status IN ('PENDING','UNKNOWN') LIMIT 1`).get(position.id, position.id);
    if (unresolved) throw new Error("Transaksi posisi belum selesai; retry swap ditolak.");
    const missingInput = this.options.db.prepare(`SELECT 1 FROM transactions t WHERE t.position_id=? AND t.kind='SWAP' AND t.status='CONFIRMED'
      AND NOT EXISTS (SELECT 1 FROM swaps s WHERE s.signature=t.signature) LIMIT 1`).get(position.id);
    if (missingInput) throw new Error("Catatan input swap terkonfirmasi belum tersedia; retry ditolak.");
    const result = this.options.db.prepare(`SELECT token_received,token_mint FROM close_results
      WHERE position_id=? AND signature=? AND mode='live' AND status='CONFIRMED' ORDER BY created_at DESC LIMIT 1`)
      .get(position.id, closeSignature) as { token_received: string | null; token_mint: string } | undefined;
    const confirmedClose = this.options.db.prepare("SELECT 1 FROM transactions WHERE signature=? AND position_id=? AND kind='CLOSE' AND status='CONFIRMED'")
      .get(closeSignature, position.id);
    if (!result?.token_received || result.token_mint !== position.tokenMint || !confirmedClose) throw new Error("Hasil close terkonfirmasi belum tersedia.");
    const sold = this.options.db.prepare(`SELECT s.signature,MAX(s.input_amount) AS input_amount FROM swaps s
      JOIN transactions t ON t.signature=s.signature WHERE s.position_id=? AND t.kind='SWAP' AND t.status='CONFIRMED'
      GROUP BY s.signature`).all(position.id) as Array<{ input_amount: string }>;
    const remaining = BigInt(result.token_received) - sold.reduce((sum, swap) => sum + BigInt(swap.input_amount), 0n);
    if (remaining <= 0n) throw new Error("Seluruh token hasil close sudah ditukar; retry ditolak.");
    const accounts = await this.options.connection.getParsedTokenAccountsByOwner(this.options.wallet, { mint: new PublicKey(position.tokenMint) }, "confirmed");
    const balance = accounts.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
    if (balance <= 0n) throw new Error("Tidak ada token hasil close tersisa di wallet.");
    return balance < remaining ? balance : remaining;
  }

  async execute(trigger: Trigger): Promise<number> {
    if (this.inFlight.has(trigger.positionId)) return 60_000;
    this.inFlight.add(trigger.positionId);
    try { return await this.closePosition(trigger); }
    catch (error) {
      const reason = safeError(error);
      if (error instanceof MetadataPending) {
        await this.deferMetadata(trigger.positionId, reason);
        return 30_000;
      }
      if (error instanceof SkipClose) {
        this.markTrigger(trigger, error.outcome);
        await this.notify(this.card("ℹ️ CLOSE DILEWATI", [
          { label: "Posisi", value: trigger.positionId, code: true },
          `Alasan ${triggerReasonLabel(trigger.reason)}`,
          `🕒 Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
          reason,
        ]));
        return 0;
      }
      const failures = Number(getMeta(this.options.db, "close_failures") ?? 0) + 1;
      setMeta(this.options.db, "close_failures", String(failures));
      setMeta(this.options.db, "close_failures_at", String(Date.now()));
      this.markTrigger(trigger, "FAILED");
      console.error("Close pipeline failed:", reason);
      await this.notify(this.card(
        failures >= 3 ? "🚨 CLOSE DIJEDA SEMENTARA" : "🔴 CLOSE GAGAL",
        [
          { label: "Posisi", value: trigger.positionId, code: true },
          `Alasan ${triggerReasonLabel(trigger.reason)}`,
          `Percobaan gagal ${failures}/3`,
          `Detail ${reason}`,
          failures >= 3
            ? "Tindakan: close dijeda 10 menit, lalu Yolow mencoba lagi otomatis."
            : "Tindakan: Yolow mencoba kembali otomatis.",
          `🕒 Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
        ],
      ));
      return failures >= 3 ? 600_000 : 60_000;
    } finally { this.inFlight.delete(trigger.positionId); }
  }

  private async closePosition(trigger: Trigger): Promise<number> {
    const position = listPositions(this.options.db).find((item) => item.id === trigger.positionId);
    if (!position) { this.markTrigger(trigger, "POSITION_CLOSED"); return 0; }
    if (position.ignored) { this.markTrigger(trigger, "IGNORED"); return 0; }
    const trade = this.options.db.prepare("SELECT mode,finalized_at,swap_status FROM trade_history WHERE position_id=?")
      .get(position.id) as { mode: string; finalized_at: number | null; swap_status: string | null } | undefined;
    if (trade?.swap_status === "WAITING_METADATA") return 30_000;
    const completed = this.options.db.prepare("SELECT 1 FROM close_results WHERE position_id=? AND mode='live' AND status='CONFIRMED' LIMIT 1").get(position.id);
    if (completed || (trade?.mode === (this.isDryRun() ? "dry_run" : "live") && trade.finalized_at !== null)) {
      this.markTrigger(trigger, "ALREADY_FINALIZED"); return 0;
    }
    this.assertFreshTrigger(trigger);
    const unresolved = this.options.db.prepare("SELECT signature FROM transactions WHERE position_id=? AND kind='CLOSE' AND status IN ('PENDING','UNKNOWN') LIMIT 1")
      .get(position.id) as { signature: string } | undefined;
    if (unresolved) { this.markTrigger(trigger, "CLOSE_PENDING"); return 300_000; }
    let failures = Number(getMeta(this.options.db, "close_failures") ?? 0);
    const failureAt = Number(getMeta(this.options.db, "close_failures_at") ?? 0);
    if (failures >= 3 && failureAt > 0 && Date.now() - failureAt >= 600_000) {
      failures = 0;
      setMeta(this.options.db, "close_failures", "0");
      setMeta(this.options.db, "close_failures_at", "0");
      await this.notify(this.card("✅ PEMANTAUAN CLOSE DILANJUTKAN", [
        "Jeda setelah kegagalan berakhir. Yolow kembali memproses sinyal exit.",
        `🕒 ${formatExitTimestamp(Date.now(), this.options.config.timezone)}`,
      ]));
    }
    if (failures >= 3) {
      this.markTrigger(trigger, "CIRCUIT_BREAKER");
      return Math.max(1, 600_000 - (Date.now() - failureAt));
    }
    if (trigger.reason !== "TAKE_PROFIT" && !(await this.recheckOor(position, trigger))) {
      this.markTrigger(trigger, "OOR_RESET");
      return 0;
    }
    let pool = await DLMM.create(this.options.connection, new PublicKey(position.pool), { cluster: "mainnet-beta" });
    let currentPosition = await pool.getPosition(new PublicKey(position.id));
    if (!currentPosition.positionData.owner.equals(this.options.wallet)) throw new Error("Posisi tidak dimiliki wallet agent");
    const dryRun = this.isDryRun();
    if (!dryRun) this.promoteTrade(position.id);
    await this.notify(this.card(
      dryRun ? "🟡 SIMULASI CLOSE DIMULAI" : "🔴 CLOSE DIMULAI",
      [
        { label: "Posisi", value: position.id, code: true },
        { label: "Pool", value: position.pool, code: true },
        `Alasan ${triggerReasonLabel(trigger.reason)}`,
        `🕒 Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
      ],
    ));
    let sent: string[] = [];
    let tokenReceived = 0n;
    let solReceivedLamports = 0n;
    let feesLamports = 0n;
    let lastFailure: unknown;
    const maxAttempts = dryRun ? 1 : Math.max(1, this.options.config.execution.max_retries);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        if (attempt > 0) {
          pool = await DLMM.create(this.options.connection, new PublicKey(position.pool), { cluster: "mainnet-beta" });
          currentPosition = await pool.getPosition(new PublicKey(position.id));
          if (!currentPosition.positionData.owner.equals(this.options.wallet)) throw new Error("Posisi tidak dimiliki wallet agent");
        }
        const txs = await pool.removeLiquidity({
          user: this.options.wallet, position: new PublicKey(position.id),
          fromBinId: position.lowerBinId, toBinId: position.upperBinId,
          bps: new BN(10_000), shouldClaimAndClose: true,
        });
        if (txs.length === 0) throw new Error("SDK tidak membentuk transaksi close");
        for (const tx of txs) {
          if (!this.isStillEligible(position.id)) throw new SkipClose("Posisi di-ignore atau tidak lagi terbuka sebelum transaksi", "IGNORED");
          await this.addPriorityFee(tx);
          const result = await this.submit(tx, position, trigger, dryRun);
          if (result.signature) sent.push(result.signature);
        }
        lastFailure = undefined;
        break;
      } catch (error) {
        if (error instanceof UnknownBroadcast || error instanceof SkipClose || dryRun || attempt + 1 >= maxAttempts) throw error;
        lastFailure = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (lastFailure) throw lastFailure;
    if (dryRun) {
      tokenReceived = this.estimateTokenAmount(pool, currentPosition, position);
      solReceivedLamports = this.estimateSolAmount(pool, currentPosition, position);
    }
    this.markTrigger(trigger, dryRun ? "DRY_RUN" : "EXECUTED");
    if (!dryRun) this.options.db.prepare("UPDATE positions SET state='CLOSED',closed_at=?,last_checked=? WHERE id=?")
      .run(Date.now(), Date.now(), position.id);
    if (!dryRun) {
      const confirmed = this.options.db.prepare("SELECT signature FROM transactions WHERE position_id=? AND kind='CLOSE' AND status='CONFIRMED' ORDER BY sent_at")
        .all(position.id) as Array<{ signature: string }>;
      sent = confirmed.map((row) => row.signature);
      for (const row of confirmed) {
        const delta = await this.transactionDeltas(row.signature, position.tokenMint);
        tokenReceived += delta.tokenDelta;
        solReceivedLamports += delta.solDelta;
        feesLamports += delta.feeLamports;
      }
    }
    this.options.db.prepare(`INSERT INTO close_results(position_id,trigger_id,token_mint,signature,mode,status,created_at,token_received,sol_received_lamports)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(position.id, this.triggerId(trigger), position.tokenMint, sent.at(-1) ?? null,
      dryRun ? "dry_run" : "live", dryRun ? "DRY_RUN" : "CONFIRMED", Date.now(), tokenReceived.toString(), solReceivedLamports.toString());
    const closedAt = Date.now();
    const closeSol = Number(solReceivedLamports) / 1e9;
    const metrics = this.positionMetrics(position.id, closedAt);
    const networkFees = Number(feesLamports) / 1e9;
    this.options.db.prepare(`UPDATE trade_history SET exit_at=?,trigger_reason=?,trigger_detail=?,close_signature=?,sol_received=?,tokens_received=?,
      exit_price_usd=?,exit_active_bin=?,network_fees_sol=?,duration_sec=?,time_in_range_pct=?,mfe_sol=?,mae_sol=?,max_drawdown_pct=?,
      max_active_bin=?,min_active_bin=?,range_exit_count=?,total_sol_returned=?,pnl_reason=CASE WHEN initial_sol_capital IS NULL THEN 'initial capital unavailable' ELSE 'estimated from first-seen snapshot' END,
      finalized_at=? WHERE position_id=?`)
      .run(closedAt, trigger.reason, JSON.stringify(trigger.detail), sent.at(-1) ?? null, closeSol, tokenReceived.toString(),
        trigger.detail.unit === "usd" && typeof trigger.detail.close === "number" ? trigger.detail.close : null,
        typeof trigger.detail.activeBin === "number" ? trigger.detail.activeBin : position.activeBin ?? null,
        networkFees, metrics.duration, metrics.inRangePct, metrics.mfe, metrics.mae, metrics.maxDrawdown,
        metrics.maxActiveBin, metrics.minActiveBin, metrics.rangeExits, closeSol,
        dryRun || !this.options.config.swap.enabled ? closedAt : null, position.id);
    this.updatePnl(position.id);
    const tradeId = (this.options.db.prepare("SELECT trade_id FROM trade_history WHERE position_id=?").get(position.id) as { trade_id: number } | undefined)?.trade_id;
    if (tradeId !== undefined) {
      const priceAvailable = trigger.detail.unit === "usd" && typeof trigger.detail.close === "number";
      const marks = this.options.db.prepare(`INSERT OR IGNORE INTO post_exit_marks(trade_id,offset_min,due_at,status,reason)
        VALUES(?,?,?, ?,?)`);
      for (const offset of this.options.config.history.post_exit_marks_min as number[]) {
        marks.run(tradeId, offset, closedAt + offset * 60_000,
          priceAvailable ? "PENDING" : "UNAVAILABLE", priceAvailable ? null : "exit price in USD unavailable");
      }
    }
    this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_FINAL',? FROM trade_history WHERE position_id=?")
      .run(Date.now(), JSON.stringify({ mode: dryRun ? "dry_run" : "live", signatures: sent }), position.id);
    setMeta(this.options.db, "close_failures", "0");
    setMeta(this.options.db, "close_failures_at", "0");
    if (dryRun) {
      if (tokenReceived > 0n) await this.finishSwap(position, tokenReceived, true, sent.at(-1));
      else this.options.db.prepare("UPDATE trade_history SET swap_status='SKIPPED_NO_TOKEN',finalized_at=? WHERE position_id=?").run(Date.now(), position.id);
      await this.exportCsv();
      await this.notify(this.card("✅ SIMULASI CLOSE SELESAI", [
        { label: "Posisi", value: position.id, code: true },
        `Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
        `Simulasi selesai ${formatExitTimestamp(Date.now(), this.options.config.timezone)}`,
        "Tidak ada transaksi yang ditandatangani atau dikirim ke blockchain.",
      ]));
      return 0;
    }
    await this.notify(this.card("✅ CLOSE TERKONFIRMASI", [
      { label: "Posisi", value: position.id, code: true },
      `Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
      `Close selesai ${formatExitTimestamp(Date.now(), this.options.config.timezone)}`,
      ...sent.map((signature) => `🔗 https://solscan.io/tx/${signature}`),
    ]));
    if (this.options.config.swap.enabled && tokenReceived > 0n) await this.finishSwap(position, tokenReceived, false, sent.at(-1));
    else {
      this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
        .run(this.options.config.swap.enabled ? "SKIPPED_NO_TOKEN" : "SKIPPED_DISABLED", Date.now(), position.id);
      if (this.options.config.swap.enabled) await this.notify(this.card("ℹ️ SWAP DILEWATI", [
        { label: "Posisi", value: position.id, code: true },
        { label: "CA", value: position.tokenMint, code: true },
        "Tidak ada token yang diterima dari close untuk ditukar ke SOL.",
      ]));
      await this.exportCsv();
    }
    return 0;
  }

  private async recheckOor(position: Position, trigger: Trigger): Promise<boolean> {
    if (position.ignored) return false;
    const pool = await DLMM.create(this.options.connection, new PublicKey(position.pool), { cluster: "mainnet-beta" });
    const activeBin = (await pool.getActiveBin()).binId;
    const solIsX = pool.tokenX.mint.address.toBase58() === SOL_MINT;
    return exitReason({ active: activeBin, lower: position.lowerBinId, upper: position.upperBinId, solIsX,
      principal: null, profit: null, ignored: position.ignored, at: Date.now() }, this.options.config.automation) === trigger.reason;
  }

  private async addPriorityFee(tx: Transaction): Promise<void> {
    const settings = this.options.config.execution.priority_fee;
    const configured = Number(settings.microlamports ?? 100_000);
    const cap = Number(settings.max_cap_microlamports ?? configured);
    const microLamports = Math.max(0, Math.min(configured, cap));
    tx.instructions = tx.instructions.filter((instruction) => {
      if (!instruction.programId.equals(ComputeBudgetProgram.programId)) return true;
      const discriminator = instruction.data[0];
      return discriminator !== 2 && discriminator !== 3;
    });
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    );
  }

  private async submit(tx: Transaction, position: Position, trigger: Trigger, dryRun: boolean): Promise<{ signature?: string }> {
    const blockhash = await this.options.connection.getLatestBlockhash("confirmed");
    tx.feePayer = this.options.wallet;
    tx.recentBlockhash = blockhash.blockhash;
    if (dryRun) {
      const unitsConsumed = await simulateLegacyTransaction(this.options.connection, tx);
      console.log(`Dry-run close simulation for ${position.id}: unitsConsumed=${unitsConsumed ?? "unknown"} (limit 1200000)`);
      return {};
    }
    if (!this.signer) throw new Error("Live mode memerlukan AGENT_KEYPAIR_PATH yang valid");
    tx.sign(this.signer);
    const signatureBytes = tx.signature;
    if (!signatureBytes) throw new Error("Signature transaksi tidak terbentuk");
    const signature = bs58.encode(signatureBytes);
    await simulateLegacyTransaction(this.options.connection, tx);
    this.assertFreshTrigger(trigger);
    if (!this.isStillEligible(position.id)) throw new SkipClose("Posisi di-ignore sebelum broadcast", "IGNORED");
    this.options.db.prepare(`INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at)
      VALUES(?,'CLOSE',?,?, 'PENDING',?) ON CONFLICT(signature) DO NOTHING`)
      .run(signature, position.id, position.pool, Date.now());
    if (!this.isStillEligible(position.id)) {
      this.options.db.prepare("UPDATE transactions SET status='CANCELLED',error=?,confirmed_at=? WHERE signature=?")
        .run("Posisi di-ignore sebelum broadcast", Date.now(), signature);
      this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_CANCELLED',? FROM trade_history WHERE position_id=?")
        .run(Date.now(), JSON.stringify({ signature, trigger }), position.id);
      throw new SkipClose("Posisi di-ignore sebelum broadcast", "IGNORED");
    }
    this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_PREPARED',? FROM trade_history WHERE position_id=?")
      .run(Date.now(), JSON.stringify({ signature, trigger }), position.id);
    try {
      await this.options.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 0 });
      this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_BROADCAST',? FROM trade_history WHERE position_id=?")
        .run(Date.now(), JSON.stringify({ signature }), position.id);
      const result = await this.options.connection.confirmTransaction({ signature, ...blockhash }, "confirmed");
      if (result.value.err) {
        this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=? WHERE signature=?")
          .run(JSON.stringify(result.value.err), Date.now(), signature);
        throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
      }
      this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
      return { signature };
    } catch (error) {
      const status = await this.options.connection.getSignatureStatuses([signature]).catch(() => null);
      const chainStatus = status?.value[0];
      if (chainStatus && (chainStatus.confirmationStatus === "confirmed" || chainStatus.confirmationStatus === "finalized") && chainStatus.err === null) {
        this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
        return { signature };
      }
      if (chainStatus?.err) {
        this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=? WHERE signature=?")
          .run(JSON.stringify(chainStatus.err), Date.now(), signature);
        throw error;
      }
      const reason = safeError(error);
      this.options.db.prepare("UPDATE transactions SET status='UNKNOWN',error=? WHERE signature=?").run(reason, signature);
      this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_UNKNOWN',? FROM trade_history WHERE position_id=?")
        .run(Date.now(), JSON.stringify({ signature, error: reason }), position.id);
      throw new UnknownBroadcast(`Transaksi ${signature} sudah disiapkan/dikirim tetapi status konfirmasi belum diketahui; tidak dikirim ulang otomatis`);
    }
  }

  private isStillEligible(id: string): boolean {
    const row = this.options.db.prepare("SELECT ignored,state FROM positions WHERE id=?").get(id) as { ignored: number; state: string } | undefined;
    return !!row && row.ignored === 0 && row.state === "OPEN";
  }

  private triggerId(trigger: Trigger): number | null {
    const row = this.options.db.prepare("SELECT id FROM triggers WHERE position_id=? AND reason=? AND confirmed_at=? ORDER BY id DESC LIMIT 1")
      .get(trigger.positionId, trigger.reason, trigger.confirmedAt) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private markTrigger(trigger: Trigger, outcome: string): void {
    this.options.db.prepare(`INSERT INTO triggers(position_id,pool,reason,detected_at,confirmed_at,detail,outcome)
      VALUES(?,?,?,?,?,?,?)`).run(trigger.positionId, trigger.pool, trigger.reason, trigger.detectedAt,
      trigger.confirmedAt, JSON.stringify(trigger.detail), outcome);
    this.options.db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload)
      SELECT trade_id,?,'TRIGGER_CONFIRMED',? FROM trade_history WHERE position_id=?`)
      .run(trigger.confirmedAt, JSON.stringify({ trigger, outcome }), trigger.positionId);
  }

  private estimateTokenAmount(pool: DLMM, positionData: any, position: Position): bigint {
    const mintIsX = pool.tokenX.mint.address.toBase58() === position.tokenMint;
    const value = mintIsX ? positionData.positionData.totalXAmountExcludeTransferFee : positionData.positionData.totalYAmountExcludeTransferFee;
    return BigInt(value.toString());
  }

  private estimateSolAmount(pool: DLMM, positionData: any, position: Position): bigint {
    const solIsX = pool.tokenX.mint.address.toBase58() === SOL_MINT;
    const solIsY = pool.tokenY.mint.address.toBase58() === SOL_MINT;
    const value = solIsX ? positionData.positionData.totalXAmountExcludeTransferFee
      : solIsY ? positionData.positionData.totalYAmountExcludeTransferFee : 0;
    return BigInt(value.toString());
  }

  private positionMetrics(positionId: string, closedAt: number): {
    duration: number; inRangePct: number | null; mfe: number | null; mae: number | null;
    maxDrawdown: number | null; maxActiveBin: number | null; minActiveBin: number | null; rangeExits: number;
  } {
    const trade = this.options.db.prepare("SELECT first_seen_at FROM trade_history WHERE position_id=?").get(positionId) as { first_seen_at: number } | undefined;
    const rows = this.options.db.prepare("SELECT active_bin,sol_value,in_range FROM position_snapshots WHERE position_id=? ORDER BY at")
      .all(positionId) as Array<{ active_bin: number; sol_value: number | null; in_range: number }>;
    let peak = 0;
    let maxDrawdown = 0;
    let rangeExits = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const value = rows[index].sol_value;
      if (value !== null) {
        peak = Math.max(peak, value);
        if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak * 100);
      }
      if (index > 0 && rows[index - 1].in_range === 1 && rows[index].in_range === 0) rangeExits += 1;
    }
    const values = rows.map((row) => row.sol_value).filter((value): value is number => value !== null);
    return {
      duration: trade ? Math.max(0, (closedAt - trade.first_seen_at) / 1000) : 0,
      inRangePct: rows.length ? rows.filter((row) => row.in_range === 1).length / rows.length * 100 : null,
      mfe: values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
      mae: values.length ? values.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null,
      maxDrawdown: values.length ? maxDrawdown : null,
      maxActiveBin: rows.length ? rows.reduce((maximum, row) => Math.max(maximum, row.active_bin), -Infinity) : null,
      minActiveBin: rows.length ? rows.reduce((minimum, row) => Math.min(minimum, row.active_bin), Infinity) : null,
      rangeExits,
    };
  }

  private updatePnl(positionId: string): void {
    const trade = this.options.db.prepare(`SELECT initial_sol_capital,total_sol_returned,network_fees_sol
      FROM trade_history WHERE position_id=?`).get(positionId) as { initial_sol_capital: number | null; total_sol_returned: number | null; network_fees_sol: number | null } | undefined;
    if (!trade || trade.initial_sol_capital === null || trade.total_sol_returned === null) return;
    const pnl = trade.total_sol_returned - trade.initial_sol_capital - (trade.network_fees_sol ?? 0);
    this.options.db.prepare(`UPDATE trade_history SET pnl_sol=?,pnl_pct=?,pnl_usd=NULL,
      pnl_reason='estimated from first-seen snapshot; USD conversion unavailable' WHERE position_id=?`)
      .run(pnl, trade.initial_sol_capital > 0 ? pnl / trade.initial_sol_capital * 100 : null, positionId);
  }

  private async transactionDeltas(signature: string, tokenMint: string): Promise<{ tokenDelta: bigint; solDelta: bigint; feeLamports: bigint }> {
    let tx: any = null;
    for (let attempt = 0; attempt < 5 && !tx; attempt += 1) {
      tx = await this.options.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const meta = tx?.meta;
    if (!meta || meta.err || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) ||
        !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
      throw new MetadataPending(`Metadata transaksi ${signature} belum tersedia; hasil belum difinalisasi`);
    }
    for (const balance of [...meta.preTokenBalances, ...meta.postTokenBalances]) {
      if (balance.mint === tokenMint && (typeof balance.owner !== "string" ||
          typeof balance.uiTokenAmount?.amount !== "string" || !/^\d{1,20}$/.test(balance.uiTokenAmount.amount))) {
        throw new MetadataPending(`Metadata token ${signature} belum lengkap`);
      }
    }
    const tokenTotal = (balances: any[] | null | undefined) => (balances ?? []).filter((balance) => balance.mint === tokenMint && balance.owner === this.options.wallet.toBase58())
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
    const tokenDelta = tokenTotal(meta.postTokenBalances) - tokenTotal(meta.preTokenBalances);
    const keys: any[] = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys ?? [];
    const walletIndex = keys.findIndex((key) => String(key) === this.options.wallet.toBase58());
    if (walletIndex < 0 || !Number.isSafeInteger(meta.preBalances[walletIndex]) || !Number.isSafeInteger(meta.postBalances[walletIndex]) ||
        !Number.isSafeInteger(meta.fee)) throw new MetadataPending(`Metadata saldo wallet ${signature} belum lengkap`);
    const solDelta = BigInt(meta.postBalances[walletIndex] - meta.preBalances[walletIndex] + meta.fee);
    return { tokenDelta: tokenDelta > 0n ? tokenDelta : 0n, solDelta: solDelta > 0n ? solDelta : 0n, feeLamports: BigInt(meta.fee ?? 0) };
  }

  private async processSwap(position: Position, tokenAmount: bigint, dryRun: boolean, closeSignature?: string): Promise<void> {
    const now = Date.now();
    const saveSwap = (status: string, values: { out?: string; usd?: number; impact?: number; signature?: string; sol?: string; error?: string; slippage?: number } = {}) => {
      this.options.db.prepare(`INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,quoted_sol_lamports,estimated_usd,slippage_bps,price_impact,status,signature,sol_received_lamports,error,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(position.id, closeSignature ?? null, position.tokenMint, tokenAmount.toString(),
        values.out ?? null, values.usd ?? null, values.slippage ?? null, values.impact ?? null, status, values.signature ?? null,
        values.sol ?? null, values.error ?? null, now, Date.now());
    };
    if (!this.options.config.swap.enabled) {
      saveSwap("SKIPPED_DISABLED");
      this.options.db.prepare(`UPDATE trade_history SET swap_status='SKIPPED_DISABLED',
        total_sol_returned=COALESCE(sol_received,0),finalized_at=COALESCE(finalized_at,?) WHERE position_id=?`)
        .run(Date.now(), position.id);
      this.updatePnl(position.id);
      return;
    }
    if (!this.options.jupiterApiKey) { saveSwap("FAILED", { error: "JUPITER_API_KEY tidak tersedia" }); throw new Error("JUPITER_API_KEY diperlukan untuk swap"); }
    if (tokenAmount <= 0n) { saveSwap("SKIPPED_DUST"); return; }
    const base = this.options.config.jupiter.base_url.replace(/\/$/, "");
    const priceBase = this.options.config.jupiter.price_base_url ?? "https://api.jup.ag/price/v3";
    let solUsd = 0;
    try {
      const priceUrl = new URL(priceBase);
      priceUrl.searchParams.set("ids", SOL_MINT);
      const response = await fetch(priceUrl, { headers: { "x-api-key": this.options.jupiterApiKey }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const body = await readJsonResponse<Record<string, { usdPrice?: number }>>(response);
      solUsd = Number(body[SOL_MINT]?.usdPrice ?? body.data?.[SOL_MINT]?.usdPrice ?? 0);
      if (!response.ok || !Number.isFinite(solUsd) || solUsd <= 0) throw new Error("SOL/USD price tidak tersedia");
    } catch (error) { saveSwap("FAILED", { error: safeError(error) }); throw error; }

    let lastError = "no route";
    for (let attempt = 0; attempt < this.options.config.swap.max_retries; attempt += 1) {
      const slippage = Math.min(this.options.config.swap.slippage_bps + attempt * 250, this.options.config.swap.max_slippage_bps);
      const buildBase = base.replace(/\/swap\/v1\/?$/, "/swap/v2");
      const buildUrl = new URL(`${buildBase}/build`);
      buildUrl.searchParams.set("inputMint", position.tokenMint);
      buildUrl.searchParams.set("outputMint", SOL_MINT);
      buildUrl.searchParams.set("amount", tokenAmount.toString());
      buildUrl.searchParams.set("taker", this.options.wallet.toBase58());
      buildUrl.searchParams.set("slippageBps", String(slippage));
      buildUrl.searchParams.set("wrapAndUnwrapSol", "true");
      let buildResponse: Response;
      let build: JupiterBuild;
      try {
        buildResponse = await fetch(buildUrl, { headers: { "x-api-key": this.options.jupiterApiKey }, redirect: "error", signal: AbortSignal.timeout(20_000) });
        build = await readJsonResponse<JupiterBuild>(buildResponse);
      } catch (error) {
        lastError = safeError(error);
        continue;
      }
      if (!buildResponse.ok || !build.outAmount || !build.swapInstruction) {
        lastError = safeError(build.errorMessage ?? build.error ?? `Jupiter build HTTP ${buildResponse.status}`);
        continue;
      }
      if (build.inputMint !== position.tokenMint || build.outputMint !== SOL_MINT ||
          build.inAmount !== tokenAmount.toString() || build.swapMode !== "ExactIn" || build.slippageBps !== slippage ||
          typeof build.outAmount !== "string" || !/^\d{1,40}$/.test(build.outAmount) || BigInt(build.outAmount) <= 0n ||
          typeof build.otherAmountThreshold !== "string" || !/^\d{1,40}$/.test(build.otherAmountThreshold) ||
          BigInt(build.otherAmountThreshold) <= 0n || BigInt(build.otherAmountThreshold) > BigInt(build.outAmount)) {
        lastError = "Jupiter mengembalikan quote yang tidak cocok dengan input swap";
        continue;
      }
      let instructions;
      try {
        const inputTokenProgram = dryRun
          ? (await this.options.connection.getAccountInfo(new PublicKey(position.tokenMint), "confirmed"))?.owner
          : await validateJupiterSource(this.options.connection, this.options.wallet, position.tokenMint);
        if (!inputTokenProgram) throw new Error("Mint sumber tidak ditemukan");
        instructions = jupiterTransactionInstructions(build, this.options.wallet, {
          inputMint: position.tokenMint, amount: tokenAmount, slippageBps: slippage, inputTokenProgram,
        });
        if (!dryRun) await validateJupiterWritableAccounts(this.options.connection, this.options.wallet, {
          inputMint: position.tokenMint, amount: tokenAmount, slippageBps: slippage, inputTokenProgram,
        }, instructions);
      } catch (error) { lastError = safeError(error); continue; }
      const priceImpact = Number(build.priceImpact ?? (Number(build.priceImpactPct ?? 0) * 100));
      if (!Number.isFinite(priceImpact) || priceImpact < 0 || priceImpact > 100) {
        lastError = "Jupiter mengembalikan price impact yang tidak valid";
        continue;
      }
      const estimatedUsd = Number(build.outAmount) / 1_000_000_000 * solUsd;
      if (estimatedUsd < this.options.config.swap.min_value_usd) {
        saveSwap("SKIPPED_DUST", { out: build.outAmount, usd: estimatedUsd, impact: priceImpact, slippage });
        this.options.db.prepare("UPDATE trade_history SET swap_status='SKIPPED_DUST',remaining_dust_usd=?,finalized_at=? WHERE position_id=?")
          .run(estimatedUsd, Date.now(), position.id);
        this.updatePnl(position.id);
        await this.notify(this.card("🟡 SWAP DILEWATI · NILAI DUST", [
          { label: "Posisi", value: position.id, code: true },
          `Estimasi nilai $${estimatedUsd.toFixed(2)} · batas swap $${this.options.config.swap.min_value_usd.toFixed(2)}`,
          "Token tetap berada di wallet karena nilainya di bawah batas minimum swap.",
        ]));
        return;
      }
      if (dryRun) {
        saveSwap("DRY_RUN_QUOTED", { out: build.outAmount, usd: estimatedUsd, impact: priceImpact, slippage });
        this.options.db.prepare("UPDATE trade_history SET swap_status='DRY_RUN_QUOTED',swap_sol_received=?,total_sol_returned=COALESCE(sol_received,0)+?,finalized_at=? WHERE position_id=?")
          .run(Number(build.outAmount) / 1e9, Number(build.outAmount) / 1e9, Date.now(), position.id);
        this.updatePnl(position.id);
        await this.notify(this.card("🟡 SIMULASI SWAP", [
          { label: "Posisi", value: position.id, code: true },
          { label: "Perkiraan diterima", value: `${notificationSol(BigInt(build.outAmount))} · sekitar $${estimatedUsd.toFixed(2)}` },
          { label: "Dampak harga", value: notificationPercent(priceImpact) },
          "Mode DRY-RUN: quote diperiksa, transaksi tidak dikirim.",
        ]));
        return;
      }
      if (!this.signer) throw new Error("Live mode memerlukan signer yang valid");
      if (!build.blockhashWithMetadata || !Array.isArray(build.blockhashWithMetadata.blockhash) ||
          build.blockhashWithMetadata.blockhash.length !== 32 ||
          build.blockhashWithMetadata.blockhash.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
          !Number.isSafeInteger(build.blockhashWithMetadata.lastValidBlockHeight) || build.blockhashWithMetadata.lastValidBlockHeight < 1) {
        lastError = "Jupiter build tidak mengembalikan blockhash yang valid";
        continue;
      }
      let transaction: VersionedTransaction;
      let recentBlockhash: string;
      const lastValidBlockHeight = build.blockhashWithMetadata.lastValidBlockHeight;
      try {
        const configuredMicroLamports = Number(this.options.config.execution.priority_fee.microlamports);
        const capMicroLamports = Number(this.options.config.execution.priority_fee.max_cap_microlamports);
        const lookupAddresses = Object.keys(build.addressesByLookupTableAddress ?? {});
        if (lookupAddresses.length > 10) throw new Error("Jupiter mengembalikan terlalu banyak lookup table");
        const lookupTables = await Promise.all(lookupAddresses.map(async (address) => {
          const result = await this.options.connection.getAddressLookupTable(new PublicKey(address), { commitment: "confirmed" });
          if (!result.value) throw new Error(`Jupiter address lookup table ${address} tidak ditemukan`);
          return result.value;
        }));
        recentBlockhash = bs58.encode(Buffer.from(build.blockhashWithMetadata.blockhash));
        const makeTransaction = (computeUnits: number) => new VersionedTransaction(new TransactionMessage({
          payerKey: this.options.wallet,
          recentBlockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, Math.min(configuredMicroLamports, capMicroLamports)) }),
            ...instructions,
          ],
        }).compileToV0Message(lookupTables));
        const simulation = await this.options.connection.simulateTransaction(makeTransaction(1_400_000), {
          commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true,
        });
        if (simulation.value.err) throw new Error(`swap simulation ${JSON.stringify(simulation.value.err)}`);
        const computeUnits = Math.min(Math.ceil((simulation.value.unitsConsumed ?? 1_200_000) * 1.2), 1_400_000);
        transaction = makeTransaction(computeUnits);
        transaction.sign([this.signer]);
      } catch (error) {
        lastError = safeError(error);
        continue;
      }
      const signature = bs58.encode(transaction.signatures[0]);
      const txTime = Date.now();
      this.options.db.exec("BEGIN IMMEDIATE");
      try {
        this.options.db.prepare(`INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at) VALUES(?,'SWAP',?,?,'PENDING',?)`)
          .run(signature, position.id, position.pool, txTime);
        saveSwap("PENDING", { out: build.outAmount, usd: estimatedUsd, impact: priceImpact, slippage, signature });
        this.options.db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload)
          SELECT trade_id,?,'SWAP_PREPARED',? FROM trade_history WHERE position_id=?`)
          .run(txTime, JSON.stringify({ signature, inputAmount: tokenAmount.toString(), quote: build.outAmount }), position.id);
        this.options.db.exec("COMMIT");
      } catch (error) { this.options.db.exec("ROLLBACK"); throw error; }
      try {
        await this.options.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 0 });
        this.options.db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload)
          SELECT trade_id,?,'SWAP_BROADCAST',? FROM trade_history WHERE position_id=?`)
          .run(Date.now(), JSON.stringify({ signature }), position.id);
        const confirmed = await this.options.connection.confirmTransaction({
          signature, blockhash: recentBlockhash, lastValidBlockHeight,
        }, "confirmed");
        if (confirmed.value.err) throw new Error(JSON.stringify(confirmed.value.err));
      } catch (error) {
        const status = await this.options.connection.getSignatureStatuses([signature]).catch(() => null);
        const chainStatus = status?.value[0];
        if (chainStatus && (chainStatus.confirmationStatus === "confirmed" || chainStatus.confirmationStatus === "finalized") && chainStatus.err === null) {
          this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
        } else if (chainStatus?.err) {
          this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=? WHERE signature=?")
            .run(JSON.stringify(chainStatus.err), Date.now(), signature);
          this.options.db.prepare("UPDATE swaps SET status='FAILED',error=?,updated_at=? WHERE signature=?")
            .run(JSON.stringify(chainStatus.err), Date.now(), signature);
          lastError = `swap transaction failed: ${JSON.stringify(chainStatus.err)}`;
          continue;
        } else {
          const reason = safeError(error);
          this.options.db.prepare("UPDATE transactions SET status='UNKNOWN',error=? WHERE signature=?").run(reason, signature);
          this.options.db.prepare("UPDATE swaps SET status='UNKNOWN',error=?,updated_at=? WHERE signature=?")
            .run("Status konfirmasi belum diketahui; tidak dikirim ulang otomatis", Date.now(), signature);
          throw new UnknownBroadcast(`Swap ${signature} sudah dikirim tetapi status belum diketahui; retry otomatis dihentikan`);
        }
      }
      this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
      this.options.db.prepare("UPDATE swaps SET status='CONFIRMED',updated_at=? WHERE signature=?").run(Date.now(), signature);
      const deltas = await this.transactionDeltas(signature, SOL_MINT);
      this.recordSwap(signature, position.id, deltas);
      const actualSol = Number(deltas.solDelta) / 1e9;
      await this.notify(this.card("✅ SWAP TERKONFIRMASI", [
        { label: "Posisi", value: position.id, code: true },
        { label: "Diterima", value: notificationSol(actualSol) },
        { label: "Perkiraan quote", value: `${notificationSol(BigInt(build.outAmount))} · dampak harga ${notificationPercent(priceImpact)}` },
        `🔗 https://solscan.io/tx/${signature}`,
      ]));
      return;
    }
    saveSwap("NO_ROUTE", { error: lastError });
    this.options.db.prepare("UPDATE trade_history SET swap_status='NO_ROUTE',finalized_at=? WHERE position_id=?").run(Date.now(), position.id);
    this.updatePnl(position.id);
    await this.notify(this.card("🔴 SWAP GAGAL", [
      { label: "Posisi", value: position.id, code: true },
      `Detail ${lastError}`,
      `Tindakan: periksa rute, lalu gunakan /retryswap ${position.id} untuk mencoba lagi.`,
    ]));
  }

  private async finishSwap(position: Position, amount: bigint, dryRun: boolean, closeSignature?: string, retry = false): Promise<void> {
    if (this.swapsInFlight.has(position.id)) return;
    this.swapsInFlight.add(position.id);
    let started = false;
    try {
      if (!dryRun || retry) {
        if (!closeSignature) throw new Error("Swap memerlukan signature close terkonfirmasi.");
        amount = await this.remainingSwapAmount(position, closeSignature);
      }
      started = true;
      await this.processSwap(position, amount, dryRun, closeSignature);
    }
    catch (error) {
      const reason = safeError(error);
      if (error instanceof MetadataPending) { await this.deferMetadata(position.id, reason); return; }
      if (retry && !started) throw error;
      const status = error instanceof UnknownBroadcast ? "UNKNOWN" : "FAILED";
      this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
        .run(status, Date.now(), position.id);
      this.updatePnl(position.id);
      await this.notify(this.card(
        status === "UNKNOWN" ? "🚨 STATUS SWAP BELUM DIKETAHUI" : "🔴 SWAP GAGAL",
        [
          { label: "Posisi", value: position.id, code: true },
          `Detail ${reason}`,
          status === "UNKNOWN"
            ? "Periksa signature di journal sebelum mengambil tindakan. Yolow tidak mengirim ulang otomatis."
            : `Periksa rute, lalu gunakan /retryswap ${position.id} untuk mencoba lagi.`,
        ],
      ));
    } finally {
      try { await this.exportCsv(); }
      finally { this.swapsInFlight.delete(position.id); }
    }
  }

  private async exportCsv(): Promise<void> {
    const settings = this.options.config.history.csv_export;
    if (!settings?.enabled) return;
    await persistTradeCsv(this.options.db, this.options.config.timezone, join(settings.dir, settings.file), this.options.config.history.post_exit_marks_min);
  }
}

export function liveModeReply(): string {
  return "⚠️ Live mode akan mengirim transaksi dari wallet agent. Jalankan /golive lagi untuk membuka konfirmasi dua langkah.";
}

export function setLiveMode(db: DatabaseSync, live: boolean): void { setMeta(db, "dry_run", live ? "false" : "true"); }
