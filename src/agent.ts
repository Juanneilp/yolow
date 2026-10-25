import { PaperAutomation } from "./automation/automation.ts";
import { AutomationMarket } from "./automation/market.ts";
import DLMM from "./meteora.ts";
import { PublicKey, type Connection } from "@solana/web3.js";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config/config.ts";
import { fetchCandleAt } from "./market-data/candles.ts";
import { safeError } from "./security.ts";
import { ActiveBinMonitor } from "./market-data/active-bin.ts";
import { listPositions } from "./positions/monitor.ts";
import { PositionPnlMonitor } from "./positions/pnl.ts";
import { CloseExecutor } from "./execution/executor.ts";
import { getMeta, setMeta } from "./storage/db.ts";
import type { DatabaseSync } from "node:sqlite";
import { persistTradeCsv } from "./journal/export.ts";
import { fetchTokenInfo, tokenLabel } from "./market-data/token-info.ts";
import { notificationCard, notificationSol, notificationPercent, type NotificationDetail, type NotificationCardOptions } from "./telegram/presentation.ts";

import { sendTelegramMessage, type Notification } from "./telegram/client.ts";

type Options = {
  connection: Connection;
  wallet: PublicKey;
  db: DatabaseSync;
  config: AppConfig;
  telegramToken: string;
  chatId: string;
  jupiterApiKey?: string;
  keypairPath?: string;
};

export class YolowAgent {
  readonly executor: CloseExecutor;
  readonly pnl: PositionPnlMonitor;
  readonly automation: PaperAutomation;
  private readonly activeBins: ActiveBinMonitor;
  private discoveryBusy = false;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly backgroundTasks = new Map<string, Promise<void>>();
  private lastProfitAlertCheckAt?: number;

  constructor(private readonly options: Options) {
    this.pnl = new PositionPnlMonitor(options.wallet.toBase58(), options.config.candles.providers.meteora?.base_url ?? "https://dlmm.datapi.meteora.ag");
    this.executor = new CloseExecutor({
      connection: options.connection, db: options.db, config: options.config,
      wallet: options.wallet, jupiterApiKey: options.jupiterApiKey,
      keypairPath: options.keypairPath, notify: this.notify,
    });
    this.activeBins = new ActiveBinMonitor({
      connection: options.connection, db: options.db,
      fallbackPollMs: options.config.rpc.oor_fallback_poll_interval_sec * 1000,
      extraPools: () => this.automation?.list().filter((item) => item.origin === "virtual" && item.state === "OPEN").map((item) => item.pool) ?? [],
    });
    this.automation = new PaperAutomation({ db: options.db, config: options.config, pnl: this.pnl,
      market: new AutomationMarket(options.connection, options.wallet, options.config, options.jupiterApiKey),
      apiKey: options.jupiterApiKey, discover: () => this.discoverForEntry(), price: (pool) => this.activeBins.latest(pool), notify: this.notify });
    if (!getMeta(options.db, "dry_run")) setMeta(options.db, "dry_run", options.config.mode.dry_run ? "true" : "false");
  }

  async start(): Promise<void> {
    await this.runBackgroundTask("position discovery", () => this.discover());
    if (this.stopped) return;
    await this.runBackgroundTask("active-bin startup", () => this.activeBins.start());
    if (this.stopped) return;
    await this.runBackgroundTask("position PnL", () => this.refreshPnl());
    if (this.stopped) return;
    await this.runBackgroundTask("position snapshots", () => this.takeSnapshots());
    if (this.stopped) return;
    await this.runBackgroundTask("post-exit marks", () => this.updatePostExitMarks());
    if (this.stopped) return;
    await this.runBackgroundTask("SOL balance check", () => this.checkLowSolBalance());
    if (this.stopped) return;
    if (this.options.config.history.csv_export.enabled) {
      await this.runBackgroundTask("startup CSV export", async () => {
        try {
          await persistTradeCsv(this.options.db, this.options.config.timezone,
            join(this.options.config.history.csv_export.dir, this.options.config.history.csv_export.file), this.options.config.history.post_exit_marks_min);
        } catch (error) {
          console.error("Initial trade CSV export failed:", safeError(error));
          await this.notify(this.card("⚠️ EXPORT CSV GAGAL", [
            safeError(error),
            "Yolow akan mencoba export lagi pada proses berikutnya.",
          ], { action: "config" }));
        }
      });
    }
    if (this.stopped) return;
    this.timers.push(setInterval(() => void this.runBackgroundTask("position discovery", () => this.discover()), this.options.config.mode.position_poll_interval_sec * 1000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("position PnL", () => this.refreshPnl()), 60_000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("position snapshots", () => this.takeSnapshots()), this.options.config.history.snapshot_interval_sec * 1000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("data retention", () => this.cleanRetainedData()), 60 * 60 * 1000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("SOL balance check", () => this.checkLowSolBalance()), 60_000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("post-exit marks", () => this.updatePostExitMarks()), 60_000));
    if (this.options.config.history.backup.enabled) this.scheduleWib("daily backup", this.options.config.history.backup.at_time, () => this.backup());
    if (this.options.config.notify.heartbeat.enabled) this.scheduleWib("daily heartbeat", this.options.config.notify.heartbeat.at_time, () => this.heartbeat());
    this.timers.push(setInterval(() => void this.runBackgroundTask("automation", async () => { await this.automation.tick(); if (!this.stopped) await this.activeBins.refreshPools(); }), 15_000));
    void this.runBackgroundTask("automation", async () => { await this.automation.tick(); if (!this.stopped) await this.activeBins.refreshPools(); });
    console.log(`Yolow agent started in ${this.executor.isDryRun() ? "DRY-RUN" : "LIVE"} mode for ${this.options.wallet.toBase58()}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.automation.stop();
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled([...this.backgroundTasks.values()]);
    await this.activeBins.close();
    this.options.db.close();
  }

  private runBackgroundTask(name: string, operation: () => Promise<void>): Promise<void> {
    const active = this.backgroundTasks.get(name);
    if (active) return active;
    let task: Promise<void>;
    task = Promise.resolve().then(operation)
      .catch((error) => console.error(`${name} failed:`, safeError(error)))
      .finally(() => { if (this.backgroundTasks.get(name) === task) this.backgroundTasks.delete(name); });
    this.backgroundTasks.set(name, task);
    return task;
  }

  private async refreshPnl(): Promise<void> {
    if (this.stopped) return;
    const results = await this.pnl.refresh(listPositions(this.options.db).map((position) => position.pool));
    if (this.stopped) return;
    const now = Date.now();
    const { enabled, interval_minutes: interval, threshold_percent: threshold } = this.options.config.notify.profit_alert;
    if (this.lastProfitAlertCheckAt === undefined) {
      this.lastProfitAlertCheckAt = now;
      return;
    }
    if (now - this.lastProfitAlertCheckAt < interval * 60_000) return;
    this.lastProfitAlertCheckAt = now;
    if (!enabled) return;
    const qualifying = listPositions(this.options.db).flatMap((position) => {
      const result = results.get(position.pool);
      const data = result?.positions.get(position.id);
      if (result?.error || result?.fetchedAt == null || now - result.fetchedAt > 120_000 ||
        data?.pnl == null || !Number.isFinite(data.pnl) || data.pnl <= 0 ||
        data.percent == null || !Number.isFinite(data.percent) || data.percent <= threshold) return [];
      return [{ position, pnl: data.pnl, percent: data.percent }];
    }).sort((a, b) => b.percent - a.percent || b.pnl - a.pnl || a.position.id.localeCompare(b.position.id));
    if (!qualifying.length) return;
    const tokens = await fetchTokenInfo(qualifying.map(({ position }) => position.tokenMint),
      this.options.jupiterApiKey, this.options.config.jupiter.tokens_base_url);
    if (this.stopped || !this.options.config.notify.profit_alert.enabled) return;
    const openIds = new Set(listPositions(this.options.db).map((position) => position.id));
    const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
    const blocks = qualifying.filter(({ position }) => openIds.has(position.id)).map(({ position, pnl, percent }) => {
      const quote = position.quoteMint === "So11111111111111111111111111111111111111112" ? "SOL" : short(position.quoteMint);
      const token = tokens.get(position.tokenMint);
      return `${token?.symbol ?? token?.name ?? short(position.tokenMint)}/${quote} · ${short(position.id)}\n🟢 PnL ${notificationSol(pnl, true)} (${notificationPercent(percent, true)})`;
    });
    if (!blocks.length) return;
    const title = "💰 POSISI PROFIT DI ATAS AMBANG";
    const summary = `${blocks.length} posisi · PnL > ${notificationPercent(threshold)} · interval ${interval} menit`;
    const footer = "Estimasi Meteora; belum dikurangi gas dan slippage.";
    const card = (page: string[], part = "") => this.card(title, [summary, ...(part ? [part] : []), "",
      ...page.flatMap((block, index) => [...(index ? ["", "──────────────", ""] : []), block]), "", footer], { at: now });
    const pages: string[][] = [[]];
    for (const block of blocks) {
      const page = pages[pages.length - 1];
      if (page.length && card([...page, block]).text.length > 3400) pages.push([block]);
      else page.push(block);
    }
    for (const [index, page] of pages.entries()) {
      if (this.stopped || !this.options.config.notify.profit_alert.enabled) return;
      const message = card(page, pages.length > 1 ? `Bagian ${index + 1}/${pages.length}` : "");
      if (index > 0) delete message.replyMarkup;
      await this.notify(message);
    }
  }

  private card(title: string, details: NotificationDetail[], options: NotificationCardOptions = {}) {
    return notificationCard(title, details, { mode: this.executor.isDryRun() ? "DRY-RUN" : "LIVE", timezone: this.options.config.timezone, ...options });
  }

  private readonly notify = async (message: Notification): Promise<void> => {
    try { await sendTelegramMessage(this.options.telegramToken, this.options.chatId, message); }
    catch (error) { console.warn("Telegram notification failed:", safeError(error)); }
  };

  private async discoverForEntry(): Promise<boolean> {
    if (this.discoveryBusy || this.stopped) return false;
    await this.discover();
    return getMeta(this.options.db, "position_discovery_failed") !== "true";
  }

  private async discover(): Promise<void> {
    if (this.discoveryBusy || this.stopped) return;
    this.discoveryBusy = true;
    try {
      const before = new Map(listPositions(this.options.db).map((position) => [position.id, position]));
      await this.executor.reconcileTransactions();
      const positions = listPositions(this.options.db);
      const present = new Set(positions.map((position) => position.id));
      const addedPositions = positions.filter((position) => !before.has(position.id));
      const removedPositions = [...before.values()].filter((position) => !present.has(position.id));
      const tokenInfo = await fetchTokenInfo(
        [...addedPositions, ...removedPositions].map((position) => position.tokenMint),
        this.options.jupiterApiKey,
        this.options.config.jupiter.tokens_base_url,
      );
      const ensureTrade = this.options.db.prepare(`INSERT OR IGNORE INTO trade_history
        (mode,position_id,pool,token_mint,opened_at,first_seen_at,entry_source,lower_bin,upper_bin,config_snapshot)
        VALUES(?,?,?,?,?,?,'first_seen_snapshot',?,?,?)`);
      for (const position of positions) {
        ensureTrade.run(this.executor.isDryRun() ? "dry_run" : "live", position.id, position.pool,
          position.tokenMint, position.firstSeenAt, position.firstSeenAt, position.lowerBinId, position.upperBinId, JSON.stringify(this.options.config));
        if (!before.has(position.id)) await this.notify(this.card("🟢 POSISI BARU TERDETEKSI", [
          { label: "Asal", value: "Posisi nyata di wallet" },
          { label: "Pemantauan", value: position.quoteMint !== "So11111111111111111111111111111111111111112" ? "Pemantauan saja · pool di luar otomatisasi SOL" : position.ignored ? "Exit diabaikan" : this.options.config.automation.enabled ? "Exit simulasi aktif" : "Otomatisasi nonaktif" },
          { label: "Bin step", value: String(position.binStep ?? "Belum tersedia") },
          { label: "Base fee", value: notificationPercent(position.baseFeePercent ?? null) },
          { label: "Range bin", value: `${position.lowerBinId}–${position.upperBinId}` },
        ], { subtitle: tokenLabel(position.tokenMint, tokenInfo.get(position.tokenMint)) + (position.quoteMint === "So11111111111111111111111111111111111111112" ? " / SOL" : " / " + position.quoteMint.slice(0, 5) + "…"),
          positionId: position.id, pool: position.pool, at: position.firstSeenAt, detailCallback: `position:view:${position.id}` }));
      }
      for (const position of removedPositions) {
        await this.notify(this.card("⚪ POSISI TIDAK LAGI DI WALLET", [
          { label: "Status", value: "Pemantauan dihentikan" },
          "Posisi tidak ditemukan pada pemindaian wallet terbaru.",
          "Informasi ini tidak memastikan apakah posisi ditutup atau dipindahkan.",
        ], { subtitle: tokenLabel(position.tokenMint, tokenInfo.get(position.tokenMint)) + (position.quoteMint === "So11111111111111111111111111111111111111112" ? " / SOL" : ""),
          positionId: position.id, pool: position.pool }));
      }
      if (getMeta(this.options.db, "position_discovery_failed") === "true") {
        setMeta(this.options.db, "position_discovery_failed", "false");
        await this.notify(this.card("✅ PEMINDAIAN POSISI PULIH", [
          "Yolow berhasil memperbarui daftar posisi wallet.",
        ]));
      }
      await this.activeBins.refreshPools();
    } catch (error) {
      console.error("Position discovery failed:", safeError(error));
      const lastAlert = Number(getMeta(this.options.db, "position_discovery_alert_at") ?? 0);
      setMeta(this.options.db, "position_discovery_failed", "true");
      if (Date.now() - lastAlert >= 300_000) {
        setMeta(this.options.db, "position_discovery_alert_at", String(Date.now()));
        await this.notify(this.card("⚠️ DAFTAR POSISI BELUM DIPERBARUI", [
          safeError(error),
          "Yolow akan mencoba kembali otomatis. Posisi yang sudah dikenal tetap tersimpan.",
        ], { action: "config" })).catch(() => undefined);
      }
    } finally { this.discoveryBusy = false; }
  }

  private async takeSnapshots(): Promise<void> {
    const now = Date.now();
    const positions = listPositions(this.options.db);
    const pools = new Map<string, DLMM>();
    const prices = new Map<string, number>();
    const activeBins = new Map<string, number>();
    for (const position of positions) {
      try {
        let pool = pools.get(position.pool);
        if (!pool) { pool = await DLMM.create(this.options.connection, new PublicKey(position.pool), { cluster: "mainnet-beta" }); pools.set(position.pool, pool); }
        const data = await pool.getPosition(new PublicKey(position.id));
        let price = prices.get(position.pool);
        if (price === undefined) {
          const active = await pool.getActiveBin();
          price = Number(active.pricePerToken);
          activeBins.set(position.pool, active.binId);
          prices.set(position.pool, price);
        }
        const xIsSol = pool.tokenX.mint.address.toBase58() === "So11111111111111111111111111111111111111112";
        const yIsSol = pool.tokenY.mint.address.toBase58() === "So11111111111111111111111111111111111111112";
        const xRaw = BigInt(data.positionData.totalXAmountExcludeTransferFee.toString());
        const yRaw = BigInt(data.positionData.totalYAmountExcludeTransferFee.toString());
        const xUi = Number(xRaw) / 10 ** pool.tokenX.mint.decimals;
        const yUi = Number(yRaw) / 10 ** pool.tokenY.mint.decimals;
        const sol = xIsSol ? xRaw.toString() : yIsSol ? yRaw.toString() : null;
        const token = xIsSol ? yRaw.toString() : xRaw.toString();
        const solValue = xIsSol ? xUi + yUi / price : yIsSol ? yUi + xUi * price : null;
        const activeBin = activeBins.get(position.pool) ?? position.activeBin ?? 0;
        const inRange = activeBin >= position.lowerBinId && activeBin <= position.upperBinId;
        this.options.db.prepare(`INSERT OR REPLACE INTO position_snapshots(position_id,at,active_bin,sol_amount,token_amount,sol_value,in_range)
          VALUES(?,?,?,?,?,?,?)`).run(position.id, now, activeBin, sol, token, solValue, inRange ? 1 : 0);
        if (solValue !== null && Number.isFinite(solValue)) {
          this.options.db.prepare(`UPDATE trade_history SET initial_sol_capital=COALESCE(initial_sol_capital,?),
            entry_active_bin=COALESCE(entry_active_bin,?) WHERE position_id=? AND finalized_at IS NULL`)
            .run(solValue, activeBin, position.id);
        }
      } catch (error) { console.warn(`Position snapshot failed for ${position.id}:`, safeError(error)); }
    }
  }

  private async cleanRetainedData(): Promise<void> {
    const now = Date.now();
    this.options.db.prepare("DELETE FROM position_snapshots WHERE at<?").run(now - this.options.config.history.snapshot_retention_days * 86_400_000);
    this.options.db.prepare("DELETE FROM candles WHERE open_time<?").run(now - this.options.config.history.candle_audit_retention_days * 86_400_000);
  }

  private async backup(): Promise<void> {
    try {
      const directory = this.options.config.history.backup.dir;
      await mkdir(directory, { recursive: true });
      const filename = join(directory, `yolow-${fileStamp(Date.now(), this.options.config.timezone)}.db`);
      const escaped = filename.replaceAll("'", "''");
      this.options.db.exec(`VACUUM INTO '${escaped}'`);
      const files = await readdir(directory);
      const backups = await Promise.all(files.filter((file) => file.startsWith("yolow-") && file.endsWith(".db"))
        .map(async (file) => ({ file, mtime: (await stat(join(directory, file))).mtimeMs })));
      backups.sort((a, b) => b.mtime - a.mtime);
      for (const item of backups.slice(this.options.config.history.backup.keep)) await import("node:fs/promises").then(({ unlink }) => unlink(join(directory, item.file)));
    } catch (error) {
      console.error("Database backup failed:", safeError(error));
      await this.notify(this.card("🔴 BACKUP DATABASE GAGAL", [
        safeError(error),
        "Periksa ruang disk dan folder backup; Yolow akan mencoba lagi sesuai jadwal.",
      ], { action: "config" })).catch(() => undefined);
    }
  }

  private async heartbeat(): Promise<void> {
    const positions = listPositions(this.options.db);
    const balance = await this.options.connection.getBalance(this.options.wallet, "confirmed");
    await this.notify(this.card("⚡ YOLOW · RINGKASAN HARIAN", [
      { label: "Wallet", value: this.options.wallet.toBase58(), code: true },
      { label: "Saldo", value: notificationSol(BigInt(balance)) },
      `Posisi terbuka ${positions.length} · sinyal exit dijeda ${positions.filter((item) => item.ignored).length}`,
    ]));
  }

  private async checkLowSolBalance(): Promise<void> {
    try {
      const balance = await this.options.connection.getBalance(this.options.wallet, "confirmed");
      const threshold = this.options.config.notify.low_sol_balance_alert_sol * 1e9;
      const wasLow = getMeta(this.options.db, "low_sol_balance") === "true";
      if (balance < threshold && !wasLow) {
        setMeta(this.options.db, "low_sol_balance", "true");
        await this.notify(this.card("⚠️ SALDO SOL RENDAH", [
          { label: "Wallet", value: this.options.wallet.toBase58(), code: true },
          { label: "Saldo saat ini", value: notificationSol(BigInt(balance)) },
          { label: "Batas notifikasi", value: notificationSol(this.options.config.notify.low_sol_balance_alert_sol) },
          "Isi saldo untuk membayar biaya transaksi bila close live diperlukan.",
        ], { action: "config" }));
      } else if (balance >= threshold && wasLow) {
        setMeta(this.options.db, "low_sol_balance", "false");
        await this.notify(this.card("✅ SALDO SOL KEMBALI NORMAL", [
          { label: "Saldo saat ini", value: notificationSol(BigInt(balance)) },
        ], { action: "config" }));
      }
    } catch (error) { console.warn("SOL balance check failed:", safeError(error)); }
  }

  private async updatePostExitMarks(): Promise<void> {
    const marks = this.options.db.prepare(`SELECT m.trade_id,m.offset_min,m.due_at,t.pool,t.exit_price_usd
      FROM post_exit_marks m JOIN trade_history t ON t.trade_id=m.trade_id
      WHERE m.status='PENDING' AND m.due_at<=?`).all(Date.now()) as Array<Record<string, any>>;
    for (const mark of marks) {
      if (!(Number(mark.exit_price_usd) > 0) || this.options.config.candles.price_unit !== "usd") {
        this.options.db.prepare("UPDATE post_exit_marks SET status='UNAVAILABLE',reason=? WHERE trade_id=? AND offset_min=?")
          .run("Exit atau candle price USD tidak tersedia", mark.trade_id, mark.offset_min);
        continue;
      }
      try {
        const candle = await fetchCandleAt(mark.pool, "5m", this.options.config, mark.due_at);
        if (candle.unit !== "usd") throw new Error(`provider menghasilkan ${candle.unit}, perlu usd`);
        this.options.db.prepare(`UPDATE post_exit_marks SET price_usd=?,percent_vs_exit=?,status='RECORDED',reason=NULL
          WHERE trade_id=? AND offset_min=?`).run(candle.close, (candle.close - mark.exit_price_usd) / mark.exit_price_usd * 100,
          mark.trade_id, mark.offset_min);
      } catch (error) {
        this.options.db.prepare("UPDATE post_exit_marks SET status='UNAVAILABLE',reason=? WHERE trade_id=? AND offset_min=?")
          .run(safeError(error).slice(0, 500), mark.trade_id, mark.offset_min);
      }
    }
  }

  private scheduleWib(name: string, atTime: string, callback: () => Promise<void>): void {
    const [hour, minute] = atTime.split(":").map(Number);
    const schedule = () => {
      const now = Date.now();
      let next = localTargetEpoch(now, hour, minute, this.options.config.timezone);
      if (next <= now) next = localTargetEpoch(now + 86_400_000, hour, minute, this.options.config.timezone);
      const timer = setTimeout(() => {
        if (this.stopped) return;
        void this.runBackgroundTask(name, callback);
        schedule();
      }, next - now);
      this.timers.push(timer as unknown as NodeJS.Timeout);
    };
    schedule();
  }
}

function fileStamp(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(epoch)).replaceAll(":", "-").replaceAll(" ", "_");
}

function localTargetEpoch(now: number, hour: number, minute: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  const offset = asUtc - (now - now % 1000);
  return Date.UTC(values.year, values.month - 1, values.day, hour, minute) - offset;
}
