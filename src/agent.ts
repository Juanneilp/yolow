import DLMM from "./meteora.ts";
import { PublicKey, type Connection } from "@solana/web3.js";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config/config.ts";
import type { Candle, Timeframe, Trigger } from "./domain/types.ts";
import { fetchCandleAt, fetchCandleSeries, loadCandles, saveCandles } from "./market-data/candles.ts";
import { indicatorExitSignal } from "./market-data/indicators.ts";
import { readJsonResponse, safeError, telegramApiBase } from "./security.ts";
import { ActiveBinMonitor } from "./market-data/active-bin.ts";
import { listPositions } from "./positions/monitor.ts";
import { CloseExecutor } from "./execution/executor.ts";
import { getMeta, setMeta } from "./storage/db.ts";
import type { DatabaseSync } from "node:sqlite";
import { persistTradeCsv } from "./journal/export.ts";
import { fetchTokenInfo, tokenLabel } from "./market-data/token-info.ts";
import { binStepLabel, notificationCard, triggerReasonLabel } from "./telegram/presentation.ts";

const timeframeMs: Record<Timeframe, number> = { "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000 };
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
  private readonly activeBins: ActiveBinMonitor;
  private discoveryBusy = false;
  private candleBusy = false;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly backgroundTasks = new Map<string, Promise<void>>();
  private readonly lastCandleSuccessByPool = new Map<string, number>();

  constructor(private readonly options: Options) {
    this.executor = new CloseExecutor({
      connection: options.connection, db: options.db, config: options.config,
      wallet: options.wallet, jupiterApiKey: options.jupiterApiKey,
      keypairPath: options.keypairPath, notify: this.notify,
    });
    this.activeBins = new ActiveBinMonitor({
      connection: options.connection, db: options.db,
      fallbackPollMs: options.config.rpc.oor_fallback_poll_interval_sec * 1000,
      below: options.config.oor_exit.below, above: options.config.oor_exit.above,
      poolOverrides: options.config.pool_overrides,
      onTrigger: (trigger) => this.onTrigger(trigger),
    });
    if (!getMeta(options.db, "active_timeframe")) setMeta(options.db, "active_timeframe", options.config.indicator_exit.timeframe);
    if (!getMeta(options.db, "dry_run")) setMeta(options.db, "dry_run", options.config.mode.dry_run ? "true" : "false");
  }

  async start(): Promise<void> {
    await this.runBackgroundTask("position discovery", () => this.discover());
    if (this.stopped) return;
    await this.runBackgroundTask("active-bin startup", () => this.activeBins.start());
    if (this.stopped) return;
    await this.runBackgroundTask("candle refresh", () => this.refreshCandles());
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
          await this.notify(notificationCard("⚠️ EXPORT CSV GAGAL", [
            safeError(error),
            "Yolow akan mencoba export lagi pada proses berikutnya.",
          ]));
        }
      });
    }
    if (this.stopped) return;
    this.timers.push(setInterval(() => void this.runBackgroundTask("position discovery", () => this.discover()), this.options.config.mode.position_poll_interval_sec * 1000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("candle refresh", () => this.refreshCandles()), this.options.config.candles.poll_interval_sec * 1000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("position snapshots", () => this.takeSnapshots()), this.options.config.history.snapshot_interval_sec * 1000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("data retention", () => this.cleanRetainedData()), 60 * 60 * 1000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("SOL balance check", () => this.checkLowSolBalance()), 60_000));
    this.timers.push(setInterval(() => void this.runBackgroundTask("post-exit marks", () => this.updatePostExitMarks()), 60_000));
    if (this.options.config.history.backup.enabled) this.scheduleWib("daily backup", this.options.config.history.backup.at_time, () => this.backup());
    if (this.options.config.notify.heartbeat.enabled) this.scheduleWib("daily heartbeat", this.options.config.notify.heartbeat.at_time, () => this.heartbeat());
    console.log(`Yolow agent started in ${this.executor.isDryRun() ? "DRY-RUN" : "LIVE"} mode for ${this.options.wallet.toBase58()}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled([...this.backgroundTasks.values()]);
    await this.activeBins.close();
    this.options.db.close();
  }

  getTimeframe(): Timeframe {
    return (getMeta(this.options.db, "active_timeframe") ?? this.options.config.indicator_exit.timeframe) as Timeframe;
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

  async setTimeframe(timeframe: Timeframe): Promise<void> {
    setMeta(this.options.db, "active_timeframe", timeframe);
    await this.refreshCandles();
  }

  private timeframeForPool(pool: string): Timeframe {
    return this.options.config.pool_overrides[pool]?.indicator_exit?.timeframe ?? this.getTimeframe();
  }

  private readonly notify = async (message: string): Promise<void> => {
    const endpoint = `${telegramApiBase(this.options.telegramToken)}/sendMessage`;
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.options.chatId, text: message, disable_web_page_preview: true }), redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Telegram notification HTTP ${response.status}`);
      const result = await readJsonResponse<{ ok?: boolean; description?: string }>(response, 1_000_000);
      if (!result.ok) throw new Error(`Telegram notification failed: ${result.description ?? "unknown"}`);
    } catch (error) { console.warn("Telegram notification failed:", safeError(error)); }
  };

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
        if (!before.has(position.id)) await this.notify(notificationCard("🟢 POSISI BARU TERDETEKSI", [
          `Token ${tokenLabel(position.tokenMint, tokenInfo.get(position.tokenMint))}`,
          `Bin step ${binStepLabel(position.binStep, position.baseFeePercent)}`,
          "ID posisi",
          position.id,
          "Pool",
          position.pool,
          `Range bin ${position.lowerBinId}–${position.upperBinId}`,
          `🕒 Mulai dipantau ${wibStamp(position.firstSeenAt, this.options.config.timezone)} WIB`,
        ]));
      }
      for (const position of removedPositions) {
        await this.notify(notificationCard("⚪ POSISI TIDAK LAGI DI WALLET", [
          `Token ${tokenLabel(position.tokenMint, tokenInfo.get(position.tokenMint))}`,
          `Bin step ${binStepLabel(position.binStep, position.baseFeePercent)}`,
          "ID posisi",
          position.id,
          `Pool ${position.pool}`,
          "Yolow menghentikan pemantauan posisi ini karena tidak menemukannya di wallet.",
          `🕒 Diperiksa ${wibStamp(Date.now(), this.options.config.timezone)} WIB`,
        ]));
      }
      if (getMeta(this.options.db, "position_discovery_failed") === "true") {
        setMeta(this.options.db, "position_discovery_failed", "false");
        await this.notify(notificationCard("✅ PEMINDAIAN POSISI PULIH", [
          "Yolow berhasil memperbarui daftar posisi wallet.",
          `🕒 ${wibStamp(Date.now(), this.options.config.timezone)} WIB`,
        ]));
      }
      await this.activeBins.refreshPools();
    } catch (error) {
      console.error("Position discovery failed:", safeError(error));
      const lastAlert = Number(getMeta(this.options.db, "position_discovery_alert_at") ?? 0);
      setMeta(this.options.db, "position_discovery_failed", "true");
      if (Date.now() - lastAlert >= 300_000) {
        setMeta(this.options.db, "position_discovery_alert_at", String(Date.now()));
        await this.notify(notificationCard("⚠️ DAFTAR POSISI BELUM DIPERBARUI", [
          safeError(error),
          "Yolow akan mencoba kembali otomatis. Posisi yang sudah dikenal tetap tersimpan.",
          `🕒 ${wibStamp(Date.now(), this.options.config.timezone)} WIB`,
        ])).catch(() => undefined);
      }
    } finally { this.discoveryBusy = false; }
  }

  private async refreshCandles(): Promise<void> {
    if (this.candleBusy || this.stopped || !this.options.config.indicator_exit.enabled) return;
    this.candleBusy = true;
    try {
      const positions = listPositions(this.options.db);
      const series = new Map<Timeframe, Set<string>>();
      for (const position of positions) {
        const timeframe = this.timeframeForPool(position.pool);
        const pools = series.get(timeframe) ?? new Set<string>();
        pools.add(position.pool);
        series.set(timeframe, pools);
      }
      for (const [timeframe, pools] of series) for (const pool of pools) {
        try {
          const candles = await fetchCandleSeries(pool, timeframe, this.options.config);
          saveCandles(this.options.db, candles, pool, timeframe);
          this.lastCandleSuccessByPool.set(`${pool}:${timeframe}`, Date.now());
          const staleKey = `stale_candles:${pool}:${timeframe}`;
          if (getMeta(this.options.db, staleKey) === "true") {
            setMeta(this.options.db, staleKey, "false");
            await this.notify(notificationCard("✅ DATA CANDLE PULIH", [
              `Pool ${pool}`,
              "Evaluasi sinyal indikator dilanjutkan. Pemantauan OOR tetap berjalan.",
              `🕒 ${wibStamp(Date.now(), this.options.config.timezone)} WIB`,
            ]));
          }
          await this.evaluateSeries(pool, timeframe, candles);
        } catch (error) {
          const now = Date.now();
          const seriesKey = `${pool}:${timeframe}`;
          const lastSuccess = this.lastCandleSuccessByPool.get(seriesKey) ?? now;
          this.lastCandleSuccessByPool.set(seriesKey, lastSuccess);
          const staleKey = `stale_candles:${pool}:${timeframe}`;
          if (now - lastSuccess >= this.options.config.candles.stale_data_pause_sec * 1000 && getMeta(this.options.db, staleKey) !== "true") {
            setMeta(this.options.db, staleKey, "true");
            await this.notify(notificationCard("⚠️ DATA CANDLE TERHENTI", [
              `Pool ${pool}`,
              `Semua sumber candle gagal selama lebih dari ${this.options.config.candles.stale_data_pause_sec} detik. Sinyal indikator dijeda; pemantauan OOR tetap berjalan.`,
              `Detail: ${safeError(error)}`,
              "Periksa koneksi sumber data melalui /config.",
              `🕒 ${wibStamp(now, this.options.config.timezone)} WIB`,
            ]));
          }
          console.warn(`Candle fetch failed for ${pool}:`, safeError(error));
        }
      }
    } finally { this.candleBusy = false; }
  }

  private async evaluateSeries(pool: string, timeframe: Timeframe, fetched: Candle[]): Promise<void> {
    const unit = fetched.at(-1)?.unit ?? this.options.config.candles.price_unit;
    const candles = loadCandles(this.options.db, pool, timeframe, unit, fetched.at(-1)?.provider ?? "", this.options.config.candles.backfill_candles);
    if (candles.length < 35) return;
    const candle = candles.at(-1)!;
    const key = `${pool}:${timeframe}:${unit}:${candle.provider}`;
    const signal = indicatorExitSignal(candles, this.options.config.indicator_exit);
    const inserted = this.options.db.prepare(`INSERT OR IGNORE INTO signals
      (series_key,asset_key,provider,timeframe,unit,candle_time,rule_fired,rsi,bb_upper,close,macd_hist,evaluated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(key, pool, candle.provider, timeframe, unit, candle.time, signal.fired ? 1 : 0,
      signal.rsi ?? null, signal.bbUpper ?? null, candle.close, signal.macdHist ?? null, Date.now());
    if (inserted.changes === 0 || !signal.fired) return;
    await this.notify(notificationCard("📈 SINYAL INDIKATOR TERKONFIRMASI", [
      `Pool ${pool}`,
      `Timeframe ${timeframe} · harga penutupan ${candle.close} ${unit.toUpperCase()}`,
      `RSI ${signal.rsi?.toFixed(2)} · BB atas ${signal.bbUpper?.toPrecision(6)} · MACD ${signal.macdHist?.toPrecision(6)}`,
      `🕒 Candle ${wibStamp(candle.time, this.options.config.timezone)} WIB`,
    ]));
    for (const position of listPositions(this.options.db).filter((item) => item.pool === pool)) {
      const detail = { ...signal, close: candle.close, candleTime: candle.time, provider: candle.provider, unit, timeframe };
      const trigger: Trigger = { positionId: position.id, pool, reason: "INDICATOR", detectedAt: Date.now(), confirmedAt: Date.now(), detail };
      if (position.ignored) {
        this.options.db.prepare(`INSERT INTO triggers(position_id,pool,reason,detected_at,confirmed_at,detail,outcome,series_key,candle_time)
          VALUES(?,?,?,?,?,?,'IGNORED',?,?)`).run(position.id, pool, "INDICATOR", trigger.detectedAt, trigger.confirmedAt, JSON.stringify(detail), key, candle.time);
      } else if (candle.time + timeframeMs[timeframe] < position.firstSeenAt + this.options.config.indicator_exit.min_age_candles * timeframeMs[timeframe]) {
        this.options.db.prepare(`INSERT INTO triggers(position_id,pool,reason,detected_at,confirmed_at,detail,outcome,series_key,candle_time)
          VALUES(?,?,?,?,?,?,'NOT_ELIGIBLE',?,?)`).run(position.id, pool, "INDICATOR", trigger.detectedAt, trigger.confirmedAt, JSON.stringify(detail), key, candle.time);
      } else await this.executor.execute(trigger);
    }
  }

  private async onTrigger(trigger: Trigger): Promise<number> {
    await this.notify(notificationCard("⚠️ SINYAL EXIT DIKONFIRMASI", [
      `Posisi ${trigger.positionId}`,
      `Pool ${trigger.pool}`,
      `Alasan ${triggerReasonLabel(trigger.reason)}`,
      `Bin aktif ${trigger.detail.activeBin} · jarak ${trigger.reason === "OOR_BELOW" ? trigger.detail.belowDistance : trigger.detail.aboveDistance} bin`,
      `Konfirmasi ${(Number(trigger.detail.confirmMs) / 1000).toFixed(1)} detik`,
      `🕒 ${wibStamp(trigger.confirmedAt, this.options.config.timezone)} WIB`,
    ]));
    return this.executor.execute(trigger);
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
      await this.notify(notificationCard("🔴 BACKUP DATABASE GAGAL", [
        safeError(error),
        "Periksa ruang disk dan folder backup; Yolow akan mencoba lagi sesuai jadwal.",
      ])).catch(() => undefined);
    }
  }

  private async heartbeat(): Promise<void> {
    const positions = listPositions(this.options.db);
    const balance = await this.options.connection.getBalance(this.options.wallet, "confirmed");
    await this.notify(notificationCard("⚡ YOLOW · RINGKASAN HARIAN", [
      `Mode ${this.executor.isDryRun() ? "🟡 DRY-RUN" : "🔴 LIVE"}`,
      `Wallet ${this.options.wallet.toBase58()}`,
      `Saldo ${(balance / 1e9).toFixed(4)} SOL`,
      `Posisi terbuka ${positions.length} · sinyal exit dijeda ${positions.filter((item) => item.ignored).length}`,
      `🕒 ${wibStamp(Date.now(), this.options.config.timezone)} WIB`,
    ]));
  }

  private async checkLowSolBalance(): Promise<void> {
    try {
      const balance = await this.options.connection.getBalance(this.options.wallet, "confirmed");
      const threshold = this.options.config.notify.low_sol_balance_alert_sol * 1e9;
      const wasLow = getMeta(this.options.db, "low_sol_balance") === "true";
      if (balance < threshold && !wasLow) {
        setMeta(this.options.db, "low_sol_balance", "true");
        await this.notify(notificationCard("⚠️ SALDO SOL RENDAH", [
          `Wallet ${this.options.wallet.toBase58()}`,
          `Saldo saat ini ${(balance / 1e9).toFixed(4)} SOL`,
          `Batas notifikasi ${this.options.config.notify.low_sol_balance_alert_sol} SOL`,
          "Isi saldo untuk membayar biaya transaksi bila close live diperlukan.",
          `🕒 ${wibStamp(Date.now(), this.options.config.timezone)} WIB`,
        ]));
      } else if (balance >= threshold && wasLow) {
        setMeta(this.options.db, "low_sol_balance", "false");
        await this.notify(notificationCard("✅ SALDO SOL KEMBALI NORMAL", [
          `Saldo saat ini ${(balance / 1e9).toFixed(4)} SOL.`,
          `🕒 ${wibStamp(Date.now(), this.options.config.timezone)} WIB`,
        ]));
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

function wibStamp(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone: timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(epoch));
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
