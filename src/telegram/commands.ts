import { join } from "node:path";
import type { Connection, PublicKey } from "@solana/web3.js";
import { timeframes, type AppConfig } from "../config/config.ts";
import { applyConfigInPlace, editablePaths, prepareConfigUpdate, writeConfigAtomically } from "../config/config-store.ts";
import { loadSigner, setLiveMode } from "../execution/executor.ts";
import { listPositions, setPositionIgnored } from "../positions/monitor.ts";
import type { PositionPnl } from "../positions/pnl.ts";
import { fetchTopCareless, formatTopCareless } from "../market-data/top-careless.ts";
import { getMeta, setMeta } from "../storage/db.ts";
import type { DatabaseSync } from "node:sqlite";
import type { YolowAgent } from "../agent.ts";
import { sendTelegramDocument, tradesCsv, writeTradesCsv } from "../journal/export.ts";
import { escapeHtml, redactSecrets, safeError } from "../security.ts";
import { fetchTokenInfo, tokenLabel } from "../market-data/token-info.ts";
import { binStepLabel, notificationCard, positionRangeStatus, triggerOutcomeLabel, triggerReasonLabel } from "./presentation.ts";

type Reply = { text: string; replyMarkup?: Record<string, unknown>; parseMode?: "HTML" };
type Options = {
  agent: YolowAgent;
  db: DatabaseSync;
  connection: Connection;
  wallet: PublicKey;
  telegramToken: string;
  chatId: string;
  keypairPath?: string;
  configPath?: string;
  jupiterApiKey?: string;
  config: AppConfig;
};

const sol = (lamports: number) => `${(lamports / 1e9).toFixed(4)} SOL`;
const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
const positionLabel = (value: string) => `${value.slice(0, 8)}…${value.slice(-5)}`;
const configPathDefault = "./config.json";
const configMenuMarkup = { inline_keyboard: [
  [{ text: "🎯 Strategi exit", callback_data: "config:section:strategy" }, { text: "📉 OOR", callback_data: "config:section:oor" }],
  [{ text: "🔥 Top Trending", callback_data: "config:section:trending" }, { text: "⚡ Eksekusi & swap", callback_data: "config:section:execution" }],
  [{ text: "🕯 Data candle", callback_data: "config:section:data" }, { text: "🔔 Notifikasi & riwayat", callback_data: "config:section:records" }],
  [{ text: "🧪 Top Careless Strat", callback_data: "config:section:careless" }, { text: "🖥 Sistem", callback_data: "config:section:system" }],
] };
const configSections: Record<string, { title: string; paths: string[] }> = {
  careless: { title: "TOP CARELESS STRAT", paths: [
    "top_careless.enabled", "top_careless.limit", "top_careless.min_market_cap_usd", "top_careless.min_token_age_days", "top_careless.min_tvl_usd",
  ] },
  strategy: { title: "STRATEGI EXIT", paths: [
    "indicator_exit.enabled", "indicator_exit.timeframe", "indicator_exit.min_age_candles",
    "indicator_exit.indicators.rsi.period", "indicator_exit.indicators.rsi.overbought",
    "indicator_exit.indicators.bb.period", "indicator_exit.indicators.bb.std_dev",
    "indicator_exit.indicators.macd.fast", "indicator_exit.indicators.macd.slow", "indicator_exit.indicators.macd.signal",
    "indicator_exit.rule.rsi_required", "indicator_exit.rule.confirmations_any_of",
  ] },
  oor: { title: "EXIT OUT-OF-RANGE", paths: [
    "oor_exit.below.enabled", "oor_exit.below.trigger_bins", "oor_exit.below.confirm_sec",
    "oor_exit.above.enabled", "oor_exit.above.trigger_bins", "oor_exit.above.confirm_sec",
  ] },
  trending: { title: "TOP TRENDING", paths: [
    "top_trending.enabled", "top_trending.limit", "top_trending.min_market_cap_usd",
    "top_trending.min_token_age_hours", "top_trending.max_token_age_days", "top_trending.min_holders",
    "top_trending.min_tvl_usd", "top_trending.min_organic_score", "top_trending.volume_window",
  ] },
  execution: { title: "EKSEKUSI & SWAP", paths: [
    "execution.max_retries", "execution.priority_fee.microlamports", "execution.priority_fee.max_cap_microlamports",
    "swap.enabled", "swap.min_value_usd", "swap.slippage_bps", "swap.max_slippage_bps", "swap.max_retries",
  ] },
  data: { title: "DATA CANDLE", paths: [
    "candles.primary", "candles.fallback_chain", "candles.price_unit", "candles.poll_interval_sec",
    "candles.grace_window_sec", "candles.backfill_candles", "candles.stale_data_pause_sec",
  ] },
  records: { title: "NOTIFIKASI & RIWAYAT", paths: [
    "notify.profit_alert.enabled", "notify.profit_alert.interval_minutes", "notify.profit_alert.threshold_percent",
    "notify.low_sol_balance_alert_sol", "notify.heartbeat.enabled", "notify.heartbeat.at_time",
    "history.snapshot_interval_sec", "history.snapshot_retention_days", "history.context_candles",
    "history.csv_export.enabled", "history.backup.enabled", "history.backup.at_time", "history.backup.keep",
  ] },
  system: { title: "SISTEM", paths: [
    "timezone", "mode.position_poll_interval_sec", "rpc.oor_fallback_poll_interval_sec",
  ] },
};

function configValueAt(config: AppConfig, path: string): unknown {
  return path.split(".").reduce<any>((value, part) => value?.[part], config);
}

function configValueText(value: unknown): string {
  if (value === undefined) return "belum diset";
  return typeof value === "string" ? value : JSON.stringify(value) ?? "null";
}

function configDisplayValue(path: string, value: unknown): string {
  return /url|http_base|ws_base/i.test(path) ? "[endpoint disembunyikan]" : configValueText(value);
}

function configSectionText(config: AppConfig, section: string): string | undefined {
  const entry = configSections[section];
  if (!entry) return undefined;
  return `⚙️ ${entry.title}\n${entry.paths.map((path) => `${path} = ${configValueText(configValueAt(config, path))}`).join("\n")}\n\nTap tombol di bawah untuk mengubah parameter.`;
}

function configSectionMarkup(section: string): Record<string, unknown> {
  const entry = configSections[section];
  const buttons = entry.paths.map((path) => ({ text: path.split(".").slice(1).join("."), callback_data: `config:edit:${path}` }));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  rows.push([{ text: "↩ Menu config", callback_data: "cmd:/config" }]);
  return { inline_keyboard: rows };
}

function auditValue(path: string, value: unknown): string {
  if (/url|http_base|ws_base/i.test(path)) return "[endpoint disembunyikan]";
  return JSON.stringify(value) ?? "null";
}
function findPosition(db: DatabaseSync, prefix: string) {
  const matches = listPositions(db).filter((position) => position.id === prefix || position.id.startsWith(prefix));
  if (matches.length > 1) throw new Error("ID posisi tidak unik; kirim lebih banyak karakter.");
  return matches[0];
}

function findTrade(db: DatabaseSync, key: string): Record<string, any> | undefined {
  return db.prepare("SELECT * FROM trade_history WHERE CAST(trade_id AS TEXT)=? OR position_id=? LIMIT 1")
    .get(key, key) as Record<string, any> | undefined;
}

function noTrade(key: string): never { throw new Error(`Trade '${key}' tidak ditemukan.`); }

const configParameterPresets: Record<string, string[]> = {
  "indicator_exit.timeframe": ["5m", "15m", "30m", "1h"],
  "top_trending.volume_window": ["4h", "12h", "24h"],
  "candles.price_unit": ["usd", "sol"],
  "candles.primary": ["gmgn", "meteora", "geckoterminal", "onchain_ticks"],
};
const configPendingInputMs = 5 * 60_000;

export function createCommandHandler(options: Options) {
  const { agent, db, connection, wallet, config, jupiterApiKey } = options;
  const configPath = options.configPath ?? configPathDefault;
  const pendingConfigInput = new Map<string, { path: string; until: number }>();
  const wib = (epoch: unknown) => typeof epoch === "number"
    ? `${new Intl.DateTimeFormat("id-ID", { timeZone: config.timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(epoch))} WIB`
    : "—";

  const applyValidatedConfigUpdate = async (path: string, rawValue: string): Promise<Reply> => {
    try {
      const update = prepareConfigUpdate(config, path, rawValue);
      if ((update.config.swap.enabled || update.config.top_trending.enabled || update.config.top_careless.enabled) && !jupiterApiKey) {
        throw new Error("JUPITER_API_KEY dibutuhkan untuk swap, Top Trending, atau Top Careless Strat.");
      }
      await writeConfigAtomically(configPath, `${JSON.stringify(update.config, null, 2)}\n`);
      applyConfigInPlace(config, update.config);
      db.prepare(`INSERT INTO config_changes(changed_at,path,old_value,new_value) VALUES(?,?,?,?)`)
        .run(Date.now(), path, auditValue(path, update.oldValue), auditValue(path, update.newValue));
      let refreshNote = "";
      if (path === "indicator_exit.timeframe") {
        try { await agent.setTimeframe(update.config.indicator_exit.timeframe); }
        catch (error) {
          const reason = safeError(error);
          console.warn("Config saved but timeframe refresh failed:", reason);
          refreshNote = `\nRefresh candle perlu dicoba ulang: ${reason}`;
        }
      }
      return { text: `✅ CONFIG DISIMPAN\n${path}\nSebelum: ${configDisplayValue(path, update.oldValue)}\nSekarang: ${configDisplayValue(path, update.newValue)}\n${update.restartRequired ? "Perubahan aktif setelah PM2 restart yolow." : "Perubahan aktif sekarang."}${refreshNote}`, replyMarkup: configMenuMarkup };
    } catch (error) {
      return { text: `❌ CONFIG TIDAK DIUBAH\n${safeError(error)}`, replyMarkup: configMenuMarkup };
    }
  };

  const configEditReply = (path: string): Reply => {
    if (!editablePaths.has(path)) {
      return { text: "❌ Parameter ini tidak dapat diubah melalui Telegram.", replyMarkup: configMenuMarkup };
    }
    const value = configValueAt(config, path);
    const presets = configParameterPresets[path];
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (typeof value === "boolean") {
      rows.push([
        { text: `${value === true ? "✓ " : ""}✅ Aktif`, callback_data: `config:set:${path}:true` },
        { text: `${value === false ? "✓ " : ""}❌ Nonaktif`, callback_data: `config:set:${path}:false` },
      ]);
    }
    if (presets) {
      const buttons = presets.map((preset) => ({ text: `${value === preset ? "✓ " : ""}${preset}`, callback_data: `config:set:${path}:${preset}` }));
      for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
    }
    if (!presets || typeof value !== "boolean") {
      rows.push([{ text: "✏️ Ketik nilai", callback_data: `config:input:${path}` }]);
    }
    rows.push([{ text: "↩ Kembali", callback_data: `config:back:${path}` }]);
    const hint = typeof value === "boolean" || presets
      ? ""
      : "\n\nNilai JSON: angka, true/false, atau [\"a\",\"b\"] untuk daftar.";
    return {
      text: `⚙️ UBAH PARAMETER\n<code>${escapeHtml(path)}</code>\nNilai saat ini: <b>${escapeHtml(configValueText(value))}</b>${hint}`,
      replyMarkup: { inline_keyboard: rows },
      parseMode: "HTML",
    };
  };

  const signed = (amount: number, precision: number): string => {
    const value = Math.abs(amount).toFixed(precision);
    const magnitude = amount !== 0 && Number(value) === 0 ? `<${(10 ** -precision).toFixed(precision)}` : value;
    return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${magnitude}`;
  };
  const pnlLine = (data?: PositionPnl): string => {
    if (data?.pnl == null) return "⚪ PnL <b>Belum tersedia</b>";
    const percent = data.percent == null ? "" : ` (${signed(data.percent, 4)}%)`;
    const icon = data.pnl > 0 ? "🟢" : data.pnl < 0 ? "🔴" : "⚪";
    return `${icon} PnL <b>${escapeHtml(signed(data.pnl, 8) + " SOL" + percent)}</b>`;
  };

  const positionsReply = async (requestedPage = 0, force = false, positionId?: string): Promise<Reply> => {
    const positions = listPositions(db);
    const back = { text: "⬅️ Kembali ke daftar", callback_data: "positions:page:0" };
    if (positionId && !positions.some((position) => position.id === positionId)) {
      return { text: "Posisi tidak lagi terbuka.", replyMarkup: { inline_keyboard: [[back]] } };
    }
    if (!positions.length) return {
      text: "📍 <b>POSISI &amp; PnL</b>\nBelum ada posisi terbuka yang terdeteksi.", parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "positions:refresh:0" }]] },
    };
    // Keep every open pool in the refresh set: the monitor prunes caches for omitted pools.
    const [results, tokens] = await Promise.all([
      agent.pnl.refresh(positions.map((position) => position.pool), force),
      fetchTokenInfo(positions.map((position) => position.tokenMint), jupiterApiKey, config.jupiter.tokens_base_url),
    ]);
    const items = positions.map((position) => {
      const result = results.get(position.pool);
      const data = result?.positions.get(position.id);
      const token = tokens.get(position.tokenMint);
      const quote = position.quoteMint === "So11111111111111111111111111111111111111112" ? "SOL" : short(position.quoteMint);
      const pair = `${token?.symbol ?? token?.name ?? short(position.tokenMint)}/${quote}`;
      const warning = result?.error
        ? result.fetchedAt == null ? "⚠️ PnL belum tersedia · pembaruan gagal" : "⚠️ Pembaruan gagal · data terakhir ditampilkan"
        : result?.fetchedAt != null && Date.now() - result.fetchedAt > 120_000 ? "⚠️ Data terakhir lebih dari 2 menit lalu"
          : data?.pnl == null ? "⚪ PnL belum tersedia di indeks Meteora" : undefined;
      return { position, result, data, pair, warning };
    }).sort((a, b) => {
      const tie = a.position.firstSeenAt - b.position.firstSeenAt || a.position.id.localeCompare(b.position.id);
      if (a.data?.pnl == null) return b.data?.pnl == null ? tie : 1;
      if (b.data?.pnl == null) return -1;
      return b.data.pnl - a.data.pnl || tie;
    });
    const footer = "Estimasi sejak posisi dibuka · Meteora\nTermasuk fee/reward; belum dikurangi gas dan slippage likuidasi.";
    if (positionId) {
      const { position, result, data, pair, warning } = items.find((item) => item.position.id === positionId)!;
      const lastTrigger = db.prepare("SELECT reason,outcome FROM triggers WHERE position_id=? ORDER BY id DESC LIMIT 1")
        .get(position.id) as { reason: string; outcome: string } | undefined;
      const signal = lastTrigger ? `${triggerReasonLabel(lastTrigger.reason)} · ${triggerOutcomeLabel(lastTrigger.outcome)}` : "Belum ada sinyal exit";
      const value = (amount: number | null | undefined) => amount == null ? "Belum tersedia" : `${amount.toFixed(8)} SOL`;
      return {
        text: [
          `📍 <b>DETAIL POSISI · ${escapeHtml(pair)}</b>`, pnlLine(data),
          position.ignored ? "⏸ <b>SINYAL EXIT DIABAIKAN</b>" : "✅ <b>EXIT AKTIF · DIPANTAU</b>",
          ...(warning ? [warning] : []), "",
          `Deposit <b>${value(data?.deposits)}</b>`, `Penarikan ${value(data?.withdrawals)}`,
          `Fee/reward diklaim ${value(data?.claimed)}`, "",
          `🪙 Token <b>${escapeHtml(tokenLabel(position.tokenMint, tokens.get(position.tokenMint)))}</b>`,
          `🧭 Bin step ${escapeHtml(binStepLabel(position.binStep, position.baseFeePercent))}`,
          `📊 Range bin <b>${position.lowerBinId}–${position.upperBinId}</b> · Bin aktif <b>${position.activeBin ?? "belum tersedia"}</b>`,
          `🧭 ${escapeHtml(positionRangeStatus(position.activeBin, position.lowerBinId, position.upperBinId, position.binStep))}`,
          "Persentase OOR: jarak harga dari batas range yang terlewati, berdasarkan bin aktif terakhir.",
          `🔔 Sinyal terakhir: ${escapeHtml(signal)}`, `🕒 Mulai dipantau: ${wib(position.firstSeenAt)}`, "",
          `Posisi <code>${escapeHtml(position.id)}</code>`, `Pool <code>${escapeHtml(position.pool)}</code>`, "",
          `Diambil: ${result?.fetchedAt == null ? "Belum tersedia" : wib(result.fetchedAt)}`,
          `Saldo diperbarui penyedia: ${data?.updatedAt == null ? "Belum tersedia" : wib(data.updatedAt)}`,
          ...(result?.error ? [escapeHtml(safeError(result.error).slice(0, 160))] : []), "", footer,
        ].join("\n"),
        parseMode: "HTML",
        replyMarkup: { inline_keyboard: [
          [{ text: "🔄 Refresh", callback_data: `position:refresh:${position.id}` },
            { text: position.ignored ? "▶️ Aktifkan exit" : "⏸ Abaikan exit", callback_data: `position:${position.ignored ? "unignore" : "ignore"}:${position.id}` }],
          [back],
        ] },
      };
    }
    const pages = Math.ceil(items.length / 5);
    const page = Math.max(0, Math.min(requestedPage, pages - 1));
    const shown = items.slice(page * 5, page * 5 + 5);
    const priced = items.filter((item) => item.data?.pnl != null);
    const total = priced.reduce((sum, item) => sum + item.data!.pnl!, 0);
    const ignored = positions.filter((position) => position.ignored).length;
    const blocks = shown.map(({ position, result, data, pair, warning }, index) => [
      `${page * 5 + index + 1}. <b>${escapeHtml(pair)}</b> · <code>${escapeHtml(short(position.id))}</code>`,
      pnlLine(data),
      `🧭 ${position.activeBin != null && position.activeBin >= position.lowerBinId && position.activeBin <= position.upperBinId ? "Dalam range" : escapeHtml(positionRangeStatus(position.activeBin, position.lowerBinId, position.upperBinId, position.binStep))} · ${position.ignored ? "⏸ Exit diabaikan" : "✅ Exit aktif"}`,
      `🕒 Diambil: ${result?.fetchedAt == null ? "Belum tersedia" : wib(result.fetchedAt)}`,
      ...(warning ? [warning] : []),
    ].join("\n"));
    const navigation = [];
    if (page > 0) navigation.push({ text: "⬅️ Sebelumnya", callback_data: `positions:page:${page - 1}` });
    if (page + 1 < pages) navigation.push({ text: "Berikutnya ➡️", callback_data: `positions:page:${page + 1}` });
    return {
      text: [
        `📍 <b>POSISI &amp; PnL</b> · ${positions.length} posisi`,
        `PnL terhitung ${priced.length}/${positions.length} · <b>${priced.length && Number.isFinite(total) ? escapeHtml(signed(total, 8) + " SOL") : "Belum tersedia"}</b>`,
        `Exit aktif ${positions.length - ignored} · Diabaikan ${ignored}`,
        `Halaman ${page + 1}/${pages} · PnL SOL terbesar`, "", blocks.join("\n\n──────────────\n\n"), "",
        "Pilih Detail untuk melihat data lengkap dan mengatur exit.", footer,
      ].join("\n"),
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [
        ...shown.map((item, index) => [{ text: `${page * 5 + index + 1} · Detail ${item.pair}`, callback_data: `position:view:${item.position.id}` }]),
        ...(navigation.length ? [navigation] : []),
        [{ text: "🔄 Refresh", callback_data: `positions:refresh:${page}` }],
      ] },
    };
  };

  const onCommand = async (command: string, args: string[]): Promise<Reply | undefined> => {
    switch (command.toLowerCase()) {
      case "/topcareless": {
        const replyMarkup = { inline_keyboard: [[
          { text: "🔄 Refresh", callback_data: "cmd:/topcareless" },
          { text: "⚙️ Filter", callback_data: "config:section:careless" },
        ]] };
        if (!config.top_careless.enabled) return { text: "🧪 TOP CARELESS STRAT\nFitur ini sedang dinonaktifkan di config.json.", replyMarkup };
        try {
          if (!jupiterApiKey) throw new Error("JUPITER_API_KEY dibutuhkan untuk Top Careless Strat.");
          const result = await fetchTopCareless(config.top_careless, jupiterApiKey,
            config.candles.providers.meteora?.base_url ?? "https://dlmm.datapi.meteora.ag", config.jupiter.tokens_base_url);
          return { text: formatTopCareless(result, config.top_careless, config.timezone), parseMode: "HTML", replyMarkup };
        } catch (error) { return { text: `🧪 TOP CARELESS STRAT\nScreening gagal: ${safeError(error)}`, replyMarkup }; }
      }
      case "/pnl":
      case "/positions": return positionsReply(0, true);
      case "/status": {
        const [balance, positions] = await Promise.all([connection.getBalance(wallet, "confirmed"), Promise.resolve(listPositions(db))]);
        const ignored = positions.filter((position) => position.ignored).length;
        const failures = Number(getMeta(db, "close_failures") ?? 0);
        const active = positions.length - ignored;
        const mode = agent.executor.isDryRun() ? "🟡 DRY-RUN" : "🔴 LIVE";
        return {
          text: [
            "⚡ <b>YOLOW · METEORA DLMM</b>",
            "━━━━━━━━━━━━━━━━━━",
            `👛 Wallet <code>${escapeHtml(short(wallet.toBase58()))}</code>`,
            `💰 Saldo <b>${sol(balance)}</b>`,
            `🛡 Mode <b>${mode}</b>`,
            `📍 Posisi <b>${active}</b> dipantau · <b>${ignored}</b> dijeda`,
            `⏱ Timeframe <b>${agent.getTimeframe()}</b> · Swap ${config.swap.enabled ? "aktif" : "nonaktif"}`,
            `🧯 Gagal close <b>${failures}/3</b>`,
            `🕒 ${wib(Date.now())}`,
          ].join("\n"),
          parseMode: "HTML",
        };
      }
      case "/config": {
        if (args[0]?.toLowerCase() === "set") {
          const path = args[1];
          const rawValue = args.slice(2).join(" ").trim();
          if (!path || !rawValue) return { text: "Gunakan /config set <path> <nilai>. Boolean dan angka ditulis sebagai JSON; string boleh tanpa tanda kutip." };
          return applyValidatedConfigUpdate(path, rawValue);
        }
        if (args.length) return { text: "Gunakan /config untuk melihat pengaturan atau /config set <path> <nilai> untuk mengubah." };
        return {
          text: `⚙️ KONFIGURASI YOLOW\nMode ${agent.executor.isDryRun() ? "🟡 DRY-RUN" : "🔴 LIVE"} · timeframe ${agent.getTimeframe()}\nPilih bagian di bawah, lalu tap parameter untuk mengubahnya.\n\nBisa juga: /config set <path> <nilai>\nMode dry_run dan secret tidak dapat diubah lewat menu.`,
          replyMarkup: configMenuMarkup,
        };
      }
      case "/tf": {
        const timeframe = args[0];
        if (timeframe === undefined) return {
          text: `⏱ TIMEFRAME INDIKATOR\nAktif: ${agent.getTimeframe()}\nPilih timeframe baru:`,
          replyMarkup: { inline_keyboard: [["5m", "15m", "30m", "1h"].map((value) => ({ text: `${agent.getTimeframe() === value ? "✓ " : ""}${value}`, callback_data: `cmd:/tf ${value}` }))] },
        };
        if (!timeframes.includes(timeframe as any)) return { text: "Gunakan /tf <5m|15m|30m|1h>." };
        await agent.setTimeframe(timeframe as (typeof timeframes)[number]);
        return { text: `Timeframe indikator diubah ke ${timeframe}. Data candle sedang diisi ulang.` };
      }
      case "/ignore":
      case "/unignore": {
        if (!args[0]) return { text: command === "/ignore"
          ? "Buka 📍 Posisi & PnL, pilih Detail, lalu tekan ⏸ Abaikan exit pada posisi yang dipilih."
          : "Buka 📍 Posisi & PnL, pilih Detail, lalu tekan ▶️ Aktifkan exit pada posisi yang dipilih." };
        const position = findPosition(db, args[0]);
        if (!position) return { text: "Posisi terbuka tidak ditemukan." };
        const ignored = command === "/ignore";
        if (!setPositionIgnored(db, position.id, ignored)) return { text: "Status posisi berubah sebelum perintah diterapkan." };
        return { text: notificationCard(
          ignored ? "⏸ SINYAL EXIT DIABAIKAN" : "▶️ SINYAL EXIT DIAKTIFKAN",
          [`Posisi ${positionLabel(position.id)}`, ignored
            ? "Data posisi tetap diperbarui, tetapi sinyal exit tidak akan dieksekusi. Aktifkan lagi dengan /unignore."
            : "Sinyal exit kembali dapat dieksekusi sesuai konfigurasi Yolow."],
        ) };
      }
      case "/history": {
        const count = args[0] === undefined ? 10 : Number(args[0]);
        if (!Number.isInteger(count) || count < 1 || count > 50) return { text: "Gunakan /history [1–50]." };
        const rows = db.prepare(`SELECT trade_id,mode,position_id,trigger_reason,total_sol_returned,pnl_sol,finalized_at
          FROM trade_history ORDER BY COALESCE(exit_at,first_seen_at) DESC LIMIT ?`).all(count) as Array<Record<string, any>>;
        if (!rows.length) return { text: "Journal masih kosong." };
        return { text: `📒 RIWAYAT ${rows.length} TRADE\n` + rows.map((row) => `#${row.trade_id} · ${row.mode.toUpperCase()} · ${row.trigger_reason ?? "berjalan"}\n${row.position_id} · kembali ${row.total_sol_returned == null ? "—" : `${Number(row.total_sol_returned).toFixed(5)} SOL`} · PnL ${row.pnl_sol == null ? "belum dihitung" : `${Number(row.pnl_sol).toFixed(5)} SOL`}\n${wib(row.finalized_at)}`).join("\n\n") };
      }
      case "/trade": {
        if (!args[0]) return { text: "Gunakan /trade <trade_id|position_id>." };
        const trade = findTrade(db, args[0]);
        if (!trade) noTrade(args[0]);
        const tags = redactSecrets(JSON.parse(trade.tags || "[]").join(", ")) || "—";
        const marks = db.prepare("SELECT offset_min,price_usd,percent_vs_exit,status,reason FROM post_exit_marks WHERE trade_id=? ORDER BY offset_min")
          .all(trade.trade_id) as Array<Record<string, any>>;
        const postExit = marks.map((mark) => `${mark.offset_min}m: ${mark.status === "RECORDED" ? `$${Number(mark.price_usd).toPrecision(6)} (${Number(mark.percent_vs_exit).toFixed(2)}%)` : redactSecrets(mark.reason ?? mark.status)}`).join(" · ") || "—";
        return { text: `📒 TRADE #${trade.trade_id}\nMode ${trade.mode} · ${trade.finalized_at ? "final" : "berjalan"}\nPosisi ${trade.position_id}\nPool ${trade.pool}\nToken ${trade.token_mint}\nRange ${trade.lower_bin}–${trade.upper_bin}\nMasuk ${wib(trade.first_seen_at)}\nKeluar ${wib(trade.exit_at)}\nTrigger ${trade.trigger_reason ?? "—"}\nSOL close ${trade.sol_received ?? "—"} · SOL swap ${trade.swap_sol_received ?? "—"}\nTotal ${trade.total_sol_returned ?? "—"} SOL · PnL ${trade.pnl_sol ?? redactSecrets(trade.pnl_reason ?? "belum dihitung")}\nSwap ${trade.swap_status ?? "—"}\nSetelah exit ${postExit}\nCatatan ${redactSecrets(trade.notes ?? "—")}\nTag ${tags}` };
      }
      case "/stats": {
        const period = args[0] ?? "all";
        if (!new Set(["7d", "30d", "all"]).has(period)) return { text: "Gunakan /stats [7d|30d|all]." };
        const cutoff = period === "all" ? 0 : Date.now() - (period === "7d" ? 7 : 30) * 86_400_000;
        const totals = db.prepare(`SELECT count(*) AS trades, count(pnl_sol) AS priced_trades,
          sum(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) AS wins,
          avg(pnl_sol) AS avg_pnl, sum(pnl_sol) AS total_pnl, avg(duration_sec) AS avg_duration
          FROM trade_history WHERE finalized_at IS NOT NULL AND finalized_at>=?`).get(cutoff) as Record<string, any>;
        const triggers = db.prepare(`SELECT trigger_reason,count(*) AS trades,avg(pnl_sol) AS avg_pnl,sum(pnl_sol) AS total_pnl
          FROM trade_history WHERE finalized_at IS NOT NULL AND finalized_at>=? GROUP BY trigger_reason ORDER BY trades DESC`).all(cutoff) as Array<Record<string, any>>;
        const pools = db.prepare(`SELECT pool,count(*) AS trades,avg(pnl_sol) AS avg_pnl,sum(pnl_sol) AS total_pnl
          FROM trade_history WHERE finalized_at IS NOT NULL AND finalized_at>=? GROUP BY pool ORDER BY trades DESC LIMIT 5`).all(cutoff) as Array<Record<string, any>>;
        const count = Number(totals.trades ?? 0);
        const pct = count && Number(totals.priced_trades) && totals.wins != null
          ? `${(Number(totals.wins) / Number(totals.priced_trades) * 100).toFixed(1)}%` : "—";
        return { text: `📊 STATISTIK ${period.toUpperCase()}\nTrade final ${count} · PnL terhitung ${totals.priced_trades} · win rate ${pct}\nRata-rata PnL ${totals.avg_pnl == null ? "—" : `${Number(totals.avg_pnl).toFixed(5)} SOL`} · total ${totals.total_pnl == null ? "—" : `${Number(totals.total_pnl).toFixed(5)} SOL`}\nDurasi rata-rata ${totals.avg_duration == null ? "—" : `${(Number(totals.avg_duration) / 3600).toFixed(1)} jam`}\n\nPer trigger\n${triggers.map((row) => `${row.trigger_reason ?? "—"}: ${row.trades} trade · ${row.total_pnl == null ? "—" : `${Number(row.total_pnl).toFixed(5)} SOL`}`).join("\n") || "—"}\n\nTop pool\n${pools.map((row) => `${short(String(row.pool))}: ${row.trades} trade`).join("\n") || "—"}` };
      }
      case "/note": {
        if (args.length < 2) return { text: "Gunakan /note <trade_id|position_id> <catatan>." };
        const trade = findTrade(db, args[0]);
        if (!trade) noTrade(args[0]);
        const note = redactSecrets(args.slice(1).join(" ")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 2000);
        db.prepare("UPDATE trade_history SET notes=? WHERE trade_id=?").run(note, trade.trade_id);
        db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload) VALUES(?,?,'NOTE',?)`)
          .run(trade.trade_id, Date.now(), JSON.stringify({ note }));
        return { text: `Catatan trade #${trade.trade_id} diperbarui.` };
      }
      case "/tag": {
        if (args.length < 2) return { text: "Gunakan /tag <trade_id|position_id> <tag>." };
        const trade = findTrade(db, args[0]);
        if (!trade) noTrade(args[0]);
        const tags = JSON.parse(trade.tags || "[]") as string[];
        const tag = redactSecrets(args.slice(1).join(" ")).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!tag) return { text: "Tag tidak boleh kosong." };
        if (!tags.includes(tag)) tags.push(tag);
        if (tags.length > 20) return { text: "Maksimal 20 tag per trade." };
        db.prepare("UPDATE trade_history SET tags=? WHERE trade_id=?").run(JSON.stringify(tags), trade.trade_id);
        db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload) VALUES(?,?,'TAG',?)`)
          .run(trade.trade_id, Date.now(), JSON.stringify({ tag, tags }));
        return { text: `Tag '${tag}' disimpan pada trade #${trade.trade_id}.` };
      }
      case "/export": {
        if (!config.history.csv_export.enabled) return { text: "Export CSV sedang dinonaktifkan di config." };
        const path = join(config.history.csv_export.dir, config.history.csv_export.file);
        const contents = tradesCsv(db, config.timezone, config.history.post_exit_marks_min);
        await writeTradesCsv(db, path, config.timezone, config.history.post_exit_marks_min);
        await sendTelegramDocument(options.telegramToken, options.chatId, config.history.csv_export.file, contents);
        return undefined;
      }
      case "/retryswap": {
        if (!args[0]) return { text: "Gunakan /retryswap <position_id>." };
        if (args[0].length < 8 || args[0].length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(args[0])) return { text: "ID posisi harus berupa prefix Base58 yang valid." };
        const rows = db.prepare("SELECT position_id FROM trade_history WHERE position_id=? OR position_id LIKE ?")
          .all(args[0], `${args[0]}%`) as Array<{ position_id: string }>;
        if (rows.length > 1) return { text: "ID posisi tidak unik; kirim lebih banyak karakter." };
        if (!rows[0]) return { text: "Trade untuk posisi tersebut tidak ditemukan." };
        await agent.executor.retrySwap(rows[0].position_id);
        return { text: `Retry swap dimulai untuk ${rows[0].position_id}.` };
      }
      case "/golive": {
        if (!agent.executor.isDryRun()) return { text: "Agent sudah dalam LIVE mode." };
        if (!options.keypairPath) return { text: "AGENT_KEYPAIR_PATH belum dikonfigurasi; mode LIVE tidak tersedia." };
        await loadSigner(options.keypairPath, wallet);
        setMeta(db, "golive_confirmation_until", String(Date.now() + 120_000));
        const balance = await connection.getBalance(wallet, "confirmed");
        const count = listPositions(db).length;
        return { text: `⚠️ KONFIRMASI LIVE MODE\nMode saat ini DRY-RUN\nWallet ${short(wallet.toBase58())}\nSaldo ${sol(balance)} · posisi terpantau ${count}\nAuto-swap ${config.swap.enabled ? "aktif" : "nonaktif"}\nKonfirmasi berlaku 2 menit.`, replyMarkup: { inline_keyboard: [[{ text: "🔴 Aktifkan LIVE", callback_data: "golive:confirm" }, { text: "↩ Batal", callback_data: "golive:cancel" }]] } };
      }
      default: return undefined;
    }
  };

  const onCallback = async (data: string): Promise<Reply | undefined> => {
    // Any explicit UI interaction other than requesting typed input means the user moved on.
    if (!data.startsWith("config:input:")) pendingConfigInput.delete(options.chatId);
    const section = /^config:section:([a-z]+)$/.exec(data);
    if (section) {
      const text = configSectionText(config, section[1]);
      return text
        ? { text, replyMarkup: configSectionMarkup(section[1]) }
        : { text: "Bagian config tidak ditemukan.", replyMarkup: configMenuMarkup };
    }
    const editPath = /^config:edit:([A-Za-z0-9_.-]+)$/.exec(data);
    if (editPath) return configEditReply(editPath[1]);
    const setValue = /^config:set:([A-Za-z0-9_.-]+):(.*)$/.exec(data);
    if (setValue) {
      const reply = await applyValidatedConfigUpdate(setValue[1], setValue[2]);
      return { ...reply, text: reply.text, replyMarkup: reply.text.startsWith("✅") ? configMenuMarkup : configEditReply(setValue[1]).replyMarkup };
    }
    const inputPath = /^config:input:([A-Za-z0-9_.-]+)$/.exec(data);
    if (inputPath) {
      const path = inputPath[1];
      if (!editablePaths.has(path)) return { text: "❌ Parameter ini tidak dapat diubah melalui Telegram.", replyMarkup: configMenuMarkup };
      pendingConfigInput.set(options.chatId, { path, until: Date.now() + configPendingInputMs });
      return {
        text: `✏️ KIRIM NILAI BARU\n<code>${escapeHtml(path)}</code>\nNilai saat ini: <b>${escapeHtml(configValueText(configValueAt(config, path)))}</b>\n\nKirim nilainya sekarang (berlaku 5 menit), atau kirim <code>batal</code>.`,
        replyMarkup: { inline_keyboard: [[{ text: "↩ Batal", callback_data: "config:cancel" }]] },
        parseMode: "HTML",
      };
    }
    if (data === "config:cancel") {
      pendingConfigInput.delete(options.chatId);
      return { text: "Input dibatalkan. Tidak ada config yang berubah.", replyMarkup: configMenuMarkup };
    }
    const backPath = /^config:back:([A-Za-z0-9_.-]+)$/.exec(data);
    if (backPath) {
      const sectionName = Object.entries(configSections).find(([, entry]) => entry.paths.includes(backPath[1]))?.[0];
      const text = sectionName ? configSectionText(config, sectionName) : undefined;
      return text
        ? { text, replyMarkup: configSectionMarkup(sectionName!) }
        : { text: "Bagian config tidak ditemukan.", replyMarkup: configMenuMarkup };
    }
    if (data === "golive:cancel") {
      setMeta(db, "golive_confirmation_until", "0");
      return { text: "Konfirmasi LIVE dibatalkan. Agent tetap DRY-RUN." };
    }
    if (data === "golive:confirm") {
      const expires = Number(getMeta(db, "golive_confirmation_until") ?? 0);
      if (expires < Date.now()) return { text: "Konfirmasi sudah kedaluwarsa. Jalankan /golive kembali." };
      if (!options.keypairPath) return { text: "AGENT_KEYPAIR_PATH belum dikonfigurasi." };
      const signer = await loadSigner(options.keypairPath, wallet);
      agent.executor.setSigner(signer);
      setLiveMode(db, true);
      setMeta(db, "golive_confirmation_until", "0");
      return { text: `🔴 LIVE MODE AKTIF\nWallet ${short(wallet.toBase58())}\nPosisi terbuka ${listPositions(db).length}\nSemua close terkonfirmasi dapat mengirim transaksi.` };
    }
    const positionsPage = /^positions:(page|refresh):(\d+)$/.exec(data);
    if (positionsPage) {
      const page = Number(positionsPage[2]);
      if (!Number.isSafeInteger(page)) return { text: "Halaman posisi tidak valid." };
      return positionsReply(page, positionsPage[1] === "refresh");
    }
    const positionView = /^position:(view|refresh):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(data);
    if (positionView) return positionsReply(0, positionView[1] === "refresh", positionView[2]);
    const positionAction = /^position:(ignore|unignore):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(data);
    if (positionAction) {
      const position = findPosition(db, positionAction[2]);
      if (!position) return { text: "Posisi tidak lagi terbuka.", replyMarkup: { inline_keyboard: [[{ text: "⬅️ Kembali ke daftar", callback_data: "positions:page:0" }]] } };
      if (!setPositionIgnored(db, position.id, positionAction[1] === "ignore")) return { text: "Status posisi berubah sebelum perintah diterapkan." };
      return positionsReply(0, false, position.id);
    }
    if (data.startsWith("cmd:")) {
      const [command = "/", ...args] = data.slice(4).split(/\s+/);
      if (!["/status", "/positions", "/pnl", "/topcareless", "/history", "/stats", "/export", "/tf", "/config", "/ignore", "/unignore", "/trade", "/note", "/tag", "/retryswap", "/golive"].includes(command.toLowerCase())) return undefined;
      return onCommand(command, args);
    }
    return undefined;
  };

  const onText = async (text: string): Promise<Reply | undefined> => {
    const pending = pendingConfigInput.get(options.chatId);
    if (!pending) return undefined;
    const trimmed = text.trim();
    const label = trimmed.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
    if (label === "menu" || label === "top trending" || trimmed.startsWith("/")) {
      // Navigation or a command abandons the pending input, matching callback behavior.
      pendingConfigInput.delete(options.chatId);
      return undefined;
    }
    if (Date.now() > pending.until) {
      pendingConfigInput.delete(options.chatId);
      return { text: "⌛ Waktu input sudah habis. Buka lagi parameternya dari menu Konfigurasi." };
    }
    if (!trimmed) return { text: "Kirim nilai baru, atau kirim batal untuk membatalkan." };
    if (/^batal$/i.test(trimmed)) {
      pendingConfigInput.delete(options.chatId);
      return { text: "Input dibatalkan. Tidak ada config yang berubah.", replyMarkup: configMenuMarkup };
    }
    pendingConfigInput.delete(options.chatId);
    return applyValidatedConfigUpdate(pending.path, trimmed);
  };

  return { onCommand, onCallback, onText };
}
