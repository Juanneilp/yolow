import type { TopCarelessConfig } from "../market-data/top-careless.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../security.ts";

export type AppConfig = {
  config_version: number;
  timezone: string;
  mode: { dry_run: boolean; position_poll_interval_sec: number };
  rpc: { http_base: string; ws_base: string; oor_fallback_poll_interval_sec: number };
  candles: {
    primary: string;
    fallback_chain: string[];
    price_unit: "usd" | "sol";
    grace_window_sec: number;
    backfill_candles: number;
    stale_data_pause_sec: number;
    providers: Record<string, any>;
  };
  automation: {
    enabled: boolean; max_positions: number; position_sol: number; min_bin_step: number;
    min_price_percent: number; profit_percent: number; oor_above_percent: number; oor_below_percent: number;
  };
  execution: { priority_fee: Record<string, any>; max_retries: number };
  swap: { enabled: boolean; output: "SOL"; min_value_usd: number; slippage_bps: number; max_slippage_bps: number; max_retries: number; close_empty_token_account: boolean };
  top_careless: TopCarelessConfig;
  jupiter: { base_url: string; tokens_base_url: string; price_base_url?: string };
  notify: {
    low_sol_balance_alert_sol: number;
    heartbeat: { enabled: boolean; at_time: string };
    profit_alert: { enabled: boolean; interval_minutes: number; threshold_percent: number };
  };
  history: Record<string, any>;
  logging: { level: string };
};

function object(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, any>;
}

function number(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`${path} must be a number >= ${min}`);
  return value;
}

function integer(value: unknown, path: string, min = 0): number {
  const result = number(value, path, min);
  if (!Number.isInteger(result)) throw new Error(`${path} must be an integer`);
  return result;
}

function endpoint(value: unknown, path: string, protocol: "https:" | "wss:", hostname?: string): void {
  if (typeof value !== "string") throw new Error(`${path} must be a URL`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${path} must be a valid URL`); }
  if (url.protocol !== protocol) throw new Error(`${path} must use ${protocol}`);
  if (hostname && url.hostname !== hostname) throw new Error(`${path} must use the trusted ${hostname} host`);
  if (url.username || url.password || [...url.searchParams.keys()].some((key) =>
    /^(?:x[-_])?(?:api[-_]?key|apikey|access[-_]?token|authorization|token|secret|password|key)$/i.test(key))) {
    throw new Error(`${path} must not contain credentials; keep API keys in .env`);
  }
}

function rejectEmbeddedSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectEmbeddedSecrets(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:token|key)$/i.test(key) || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|secret|private[_-]?key|password|authorization)$/i.test(key)) {
        throw new Error("Config tidak boleh menyimpan API key atau secret; gunakan .env");
      }
      rejectEmbeddedSecrets(item);
    }
  } else if (typeof value === "string" && redactSecrets(value) !== value) {
    throw new Error("Config tidak boleh menyimpan API key atau credential; gunakan .env");
  }
}

function outputDirectory(value: string, path: string): void {
  const resolved = resolve(value);
  const fromProject = relative(process.cwd(), resolved);
  if (!fromProject || fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject)) {
    throw new Error(`${path} must stay inside the Yolow project directory`);
  }
}

export function parseConfig(text: string): AppConfig {
  const config = object(JSON.parse(text), "config");
  rejectEmbeddedSecrets(config);
  if (config.config_version !== 1) throw new Error("config_version must be 1");
  const mode = object(config.mode, "mode");
  const rpc = object(config.rpc, "rpc");
  const candles = object(config.candles, "candles");
  delete config.indicator_exit;
  delete config.oor_exit;
  delete config.pool_overrides;
  delete mode.shadow_candles;
  delete candles.poll_interval_sec;
  if (config.automation === undefined) config.automation = {};
  const automation = object(config.automation, "automation");
  for (const [key, value] of Object.entries({ enabled: false, max_positions: 15, position_sol: 0.5,
    min_bin_step: 80, min_price_percent: -80, profit_percent: 5, oor_above_percent: 10, oor_below_percent: 30 })) {
    if (automation[key] === undefined) automation[key] = value;
  }
  if (typeof automation.enabled !== "boolean") throw new Error("automation.enabled must be boolean");
  integer(automation.max_positions, "automation.max_positions", 1);
  if (automation.max_positions > 15) throw new Error("automation.max_positions cannot exceed 15");
  number(automation.position_sol, "automation.position_sol", 0.000000001);
  if (!Number.isSafeInteger(Math.round(automation.position_sol * 1e9))) throw new Error("automation.position_sol is too large");
  integer(automation.min_bin_step, "automation.min_bin_step", 80);
  number(-automation.min_price_percent, "negative automation.min_price_percent", 0.01);
  if (automation.min_price_percent <= -100) throw new Error("automation.min_price_percent must exceed -100");
  for (const key of ["profit_percent", "oor_above_percent", "oor_below_percent"]) number(automation[key], `automation.${key}`, 0.01);
  const profitBps = Math.round(automation.profit_percent * 100);
  if (!Number.isSafeInteger(profitBps) || Math.abs(profitBps - automation.profit_percent * 100) > 1e-7) throw new Error("automation.profit_percent must use at most two decimals");
  if (automation.oor_below_percent >= 100) throw new Error("automation.oor_below_percent must be below 100");
  if (automation.enabled && !mode.dry_run) throw new Error("Automation currently requires DRY-RUN");
  const swap = object(config.swap, "swap");
  if (config.top_careless === undefined) config.top_careless = {};
  const careless = object(config.top_careless, "top_careless");
  for (const [key, value] of Object.entries({ enabled: true, limit: 10, min_market_cap_usd: 1_500_000, min_token_age_days: 3, min_tvl_usd: 5_000 })) {
    if (careless[key] === undefined) careless[key] = value;
  }
  if (typeof careless.enabled !== "boolean") throw new Error("top_careless.enabled must be boolean");
  integer(careless.limit, "top_careless.limit", 1);
  if (careless.limit > 100) throw new Error("top_careless.limit cannot exceed 100");
  for (const key of ["min_market_cap_usd", "min_token_age_days", "min_tvl_usd"]) number(careless[key], `top_careless.${key}`, 0);
  const history = object(config.history, "history");
  const execution = object(config.execution, "execution");
  const notify = object(config.notify, "notify");
  const heartbeat = object(notify.heartbeat, "notify.heartbeat");
  if (notify.profit_alert === undefined) notify.profit_alert = {};
  const profitAlert = object(notify.profit_alert, "notify.profit_alert");
  if (profitAlert.enabled === undefined) profitAlert.enabled = true;
  if (profitAlert.interval_minutes === undefined) profitAlert.interval_minutes = 5;
  if (profitAlert.threshold_percent === undefined) profitAlert.threshold_percent = 5;
  const csv = object(history.csv_export, "history.csv_export");
  const backup = object(history.backup, "history.backup");
  const timezone = String(config.timezone ?? "");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new Error("timezone must be a valid IANA time zone"); }
  if (mode.dry_run !== true && mode.dry_run !== false) throw new Error("mode.dry_run must be boolean");
  integer(mode.position_poll_interval_sec, "mode.position_poll_interval_sec", 1);
  integer(rpc.oor_fallback_poll_interval_sec, "rpc.oor_fallback_poll_interval_sec", 1);
  for (const key of ["http_base", "ws_base"]) if (typeof rpc[key] !== "string" || !rpc[key]) throw new Error(`rpc.${key} is required`);
  endpoint(rpc.http_base, "rpc.http_base", "https:", "mainnet.helius-rpc.com");
  endpoint(rpc.ws_base, "rpc.ws_base", "wss:", "mainnet.helius-rpc.com");
  if (typeof candles.primary !== "string" || !candles.primary) throw new Error("candles.primary is required");
  if (!Array.isArray(candles.fallback_chain) || candles.fallback_chain.some((name: unknown) => typeof name !== "string")) throw new Error("candles.fallback_chain must be a string array");
  if (!new Set(["usd", "sol"]).has(candles.price_unit)) throw new Error("candles.price_unit must be usd or sol");
  integer(candles.grace_window_sec, "candles.grace_window_sec", 0);
  integer(candles.backfill_candles, "candles.backfill_candles", 35);
  integer(candles.stale_data_pause_sec, "candles.stale_data_pause_sec", 1);
  for (const key of ["enabled", "close_empty_token_account"]) if (typeof swap[key] !== "boolean") throw new Error(`swap.${key} must be boolean`);
  if (automation.enabled && !swap.enabled) throw new Error("Automation requires swap.enabled");
  if (swap.output !== "SOL") throw new Error("swap.output must be SOL");
  number(swap.min_value_usd, "swap.min_value_usd", 0.2);
  integer(swap.slippage_bps, "swap.slippage_bps", 1);
  integer(swap.max_slippage_bps, "swap.max_slippage_bps", swap.slippage_bps);
  if (swap.max_slippage_bps > 10_000) throw new Error("swap.max_slippage_bps cannot exceed 10000");
  integer(swap.max_retries, "swap.max_retries", 1);
  if (swap.max_retries > 3) throw new Error("swap.max_retries cannot exceed 3");
  if (swap.close_empty_token_account) throw new Error("swap.close_empty_token_account is not implemented yet");
  if (swap.enabled && (!config.jupiter?.base_url || !config.jupiter?.tokens_base_url)) throw new Error("Jupiter URLs are required when swaps are enabled");
  endpoint(config.jupiter?.base_url, "jupiter.base_url", "https:", "api.jup.ag");
  endpoint(config.jupiter?.tokens_base_url, "jupiter.tokens_base_url", "https:", "api.jup.ag");
  if (config.jupiter?.price_base_url !== undefined) endpoint(config.jupiter.price_base_url, "jupiter.price_base_url", "https:", "api.jup.ag");
  integer(execution.max_retries, "execution.max_retries", 1);
  if (execution.max_retries > 3) throw new Error("execution.max_retries cannot exceed 3");
  const priorityFee = object(execution.priority_fee, "execution.priority_fee");
  if (priorityFee.mode !== "fixed") throw new Error("execution.priority_fee.mode must be fixed");
  integer(priorityFee.microlamports, "execution.priority_fee.microlamports", 0);
  integer(priorityFee.max_cap_microlamports, "execution.priority_fee.max_cap_microlamports", 0);
  if (priorityFee.microlamports > priorityFee.max_cap_microlamports) throw new Error("priority fee cannot exceed its configured cap");
  number(notify.low_sol_balance_alert_sol, "notify.low_sol_balance_alert_sol", 0);
  if (typeof profitAlert.enabled !== "boolean") throw new Error("notify.profit_alert.enabled must be boolean");
  integer(profitAlert.interval_minutes, "notify.profit_alert.interval_minutes", 1);
  number(profitAlert.threshold_percent, "notify.profit_alert.threshold_percent", 0);
  if (typeof heartbeat.enabled !== "boolean") throw new Error("notify.heartbeat.enabled must be boolean");
  if (typeof heartbeat.at_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(heartbeat.at_time)) throw new Error("notify.heartbeat.at_time must use HH:mm");
  if (typeof history.enabled !== "boolean" || typeof history.record_dry_run_trades !== "boolean") throw new Error("history enablement flags must be boolean");
  if (!history.enabled) throw new Error("history.enabled must remain true while position execution is enabled");
  if (mode.dry_run && !history.record_dry_run_trades) throw new Error("history.record_dry_run_trades must be true in dry-run mode");
  integer(history.snapshot_interval_sec, "history.snapshot_interval_sec", 1);
  integer(history.snapshot_retention_days, "history.snapshot_retention_days", 1);
  integer(history.candle_audit_retention_days, "history.candle_audit_retention_days", 1);
  delete history.context_candles;
  if (!Array.isArray(history.post_exit_marks_min) || history.post_exit_marks_min.some((value: unknown) => !Number.isInteger(value) || (value as number) <= 0)) throw new Error("history.post_exit_marks_min must be positive integers");
  if (typeof csv.enabled !== "boolean" || typeof csv.dir !== "string" || !csv.dir || typeof csv.file !== "string" || !csv.file) throw new Error("history.csv_export is invalid");
  outputDirectory(csv.dir, "history.csv_export.dir");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.csv$/i.test(csv.file)) throw new Error("history.csv_export.file must be a plain .csv filename");
  if (typeof backup.enabled !== "boolean" || typeof backup.dir !== "string" || !backup.dir || typeof backup.at_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(backup.at_time)) throw new Error("history.backup is invalid");
  outputDirectory(backup.dir, "history.backup.dir");
  integer(backup.keep, "history.backup.keep", 1);
  if (typeof config.logging?.level !== "string") throw new Error("logging.level is required");
  for (const [provider, settings] of Object.entries(object(candles.providers, "candles.providers"))) {
    if (provider === "meteora" || provider === "geckoterminal") {
      const value = object(settings, `candles.providers.${provider}`);
      endpoint(value.base_url, `candles.providers.${provider}.base_url`, "https:",
        provider === "meteora" ? "dlmm.datapi.meteora.ag" : "api.geckoterminal.com");
    }
  }
  return config as AppConfig;
}
