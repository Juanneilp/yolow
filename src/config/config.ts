import type { Timeframe } from "../domain/types.ts";

export type AppConfig = {
  config_version: number;
  timezone: string;
  mode: { dry_run: boolean; shadow_candles: boolean; position_poll_interval_sec: number };
  rpc: { http_base: string; ws_base: string; oor_fallback_poll_interval_sec: number };
  candles: {
    primary: string;
    fallback_chain: string[];
    price_unit: "usd" | "sol";
    poll_interval_sec: number;
    grace_window_sec: number;
    backfill_candles: number;
    stale_data_pause_sec: number;
    providers: Record<string, any>;
  };
  indicator_exit: { enabled: boolean; timeframe: Timeframe; min_age_candles: number; indicators: Record<string, any>; rule: Record<string, any> };
  oor_exit: { evaluation: "live"; below: { enabled: boolean; trigger_bins: number; confirm_sec: number }; above: { enabled: boolean; trigger_bins: number; confirm_sec: number } };
  pool_overrides: Record<string, {
    indicator_exit?: { timeframe?: Timeframe };
    oor_exit?: {
      below?: Partial<{ enabled: boolean; trigger_bins: number; confirm_sec: number }>;
      above?: Partial<{ enabled: boolean; trigger_bins: number; confirm_sec: number }>;
    };
  }>;
  execution: { priority_fee: Record<string, any>; max_retries: number };
  swap: { enabled: boolean; output: "SOL"; min_value_usd: number; slippage_bps: number; max_slippage_bps: number; max_retries: number; close_empty_token_account: boolean };
  top_trending: { enabled: boolean; limit: number; min_market_cap_usd: number; min_token_age_hours: number; max_token_age_days: number; min_holders: number; min_tvl_usd: number; min_organic_score: number };
  jupiter: { base_url: string; tokens_base_url: string; price_base_url?: string };
  notify: { low_sol_balance_alert_sol: number; heartbeat: { enabled: boolean; at_time: string } };
  history: Record<string, any>;
  logging: { level: string };
};

const timeframes: Timeframe[] = ["5m", "15m", "30m", "1h"];

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

export function parseConfig(text: string): AppConfig {
  const config = object(JSON.parse(text), "config");
  if (config.config_version !== 1) throw new Error("config_version must be 1");
  const mode = object(config.mode, "mode");
  const rpc = object(config.rpc, "rpc");
  const candles = object(config.candles, "candles");
  const indicator = object(config.indicator_exit, "indicator_exit");
  const oor = object(config.oor_exit, "oor_exit");
  const swap = object(config.swap, "swap");
  const trending = object(config.top_trending, "top_trending");
  const history = object(config.history, "history");
  const execution = object(config.execution, "execution");
  const notify = object(config.notify, "notify");
  const heartbeat = object(notify.heartbeat, "notify.heartbeat");
  const csv = object(history.csv_export, "history.csv_export");
  const backup = object(history.backup, "history.backup");
  const poolOverrides = object(config.pool_overrides, "pool_overrides");
  const timezone = String(config.timezone ?? "");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new Error("timezone must be a valid IANA time zone"); }
  if (mode.dry_run !== true && mode.dry_run !== false) throw new Error("mode.dry_run must be boolean");
  if (typeof mode.shadow_candles !== "boolean") throw new Error("mode.shadow_candles must be boolean");
  integer(mode.position_poll_interval_sec, "mode.position_poll_interval_sec", 1);
  integer(rpc.oor_fallback_poll_interval_sec, "rpc.oor_fallback_poll_interval_sec", 1);
  for (const key of ["http_base", "ws_base"]) if (typeof rpc[key] !== "string" || !rpc[key]) throw new Error(`rpc.${key} is required`);
  for (const key of ["http_base", "ws_base"]) {
    try { new URL(rpc[key]); } catch { throw new Error(`rpc.${key} must be a valid URL`); }
  }
  if (typeof candles.primary !== "string" || !candles.primary) throw new Error("candles.primary is required");
  if (!Array.isArray(candles.fallback_chain) || candles.fallback_chain.some((name: unknown) => typeof name !== "string")) throw new Error("candles.fallback_chain must be a string array");
  if (!new Set(["usd", "sol"]).has(candles.price_unit)) throw new Error("candles.price_unit must be usd or sol");
  integer(candles.poll_interval_sec, "candles.poll_interval_sec", 1);
  integer(candles.grace_window_sec, "candles.grace_window_sec", 0);
  integer(candles.backfill_candles, "candles.backfill_candles", 35);
  integer(candles.stale_data_pause_sec, "candles.stale_data_pause_sec", 1);
  if (!timeframes.includes(indicator.timeframe)) throw new Error("indicator_exit.timeframe is unsupported");
  integer(indicator.min_age_candles, "indicator_exit.min_age_candles", 0);
  const indicatorValues = object(indicator.indicators, "indicator_exit.indicators");
  const rsi = object(indicatorValues.rsi, "indicator_exit.indicators.rsi");
  const bb = object(indicatorValues.bb, "indicator_exit.indicators.bb");
  const macd = object(indicatorValues.macd, "indicator_exit.indicators.macd");
  integer(rsi.period, "indicator_exit.indicators.rsi.period", 1);
  number(rsi.overbought, "indicator_exit.indicators.rsi.overbought", 0);
  if (rsi.overbought > 100) throw new Error("RSI overbought cannot exceed 100");
  integer(bb.period, "indicator_exit.indicators.bb.period", 2);
  number(bb.std_dev, "indicator_exit.indicators.bb.std_dev", 0);
  integer(macd.fast, "indicator_exit.indicators.macd.fast", 1);
  integer(macd.slow, "indicator_exit.indicators.macd.slow", 2);
  integer(macd.signal, "indicator_exit.indicators.macd.signal", 1);
  if (macd.fast >= macd.slow) throw new Error("MACD fast period must be less than slow period");
  const rule = object(indicator.rule, "indicator_exit.rule");
  if (typeof rule.rsi_required !== "boolean") throw new Error("indicator_exit.rule.rsi_required must be boolean");
  if (!Array.isArray(rule.confirmations_any_of) || rule.confirmations_any_of.length === 0 ||
      rule.confirmations_any_of.some((value: unknown) => !["bb_breakout", "macd_first_green"].includes(String(value)))) {
    throw new Error("indicator_exit.rule.confirmations_any_of must contain bb_breakout and/or macd_first_green");
  }
  for (const side of ["below", "above"] as const) {
    const value = object(oor[side], `oor_exit.${side}`);
    if (typeof value.enabled !== "boolean") throw new Error(`oor_exit.${side}.enabled must be boolean`);
    integer(value.trigger_bins, `oor_exit.${side}.trigger_bins`, 1);
    number(value.confirm_sec, `oor_exit.${side}.confirm_sec`, 0);
  }
  for (const [pool, rawOverride] of Object.entries(poolOverrides)) {
    if (!pool) throw new Error("pool_overrides keys must be pool addresses");
    const override = object(rawOverride, `pool_overrides.${pool}`);
    for (const key of Object.keys(override)) {
      if (key !== "indicator_exit" && key !== "oor_exit") throw new Error(`pool_overrides.${pool}.${key} is not supported`);
    }
    if (override.indicator_exit !== undefined) {
      const value = object(override.indicator_exit, `pool_overrides.${pool}.indicator_exit`);
      for (const key of Object.keys(value)) if (key !== "timeframe") throw new Error(`pool_overrides.${pool}.indicator_exit.${key} is not supported`);
      if (value.timeframe !== undefined && !timeframes.includes(value.timeframe)) throw new Error(`pool_overrides.${pool}.indicator_exit.timeframe is unsupported`);
    }
    if (override.oor_exit !== undefined) {
      const value = object(override.oor_exit, `pool_overrides.${pool}.oor_exit`);
      for (const key of Object.keys(value)) if (key !== "below" && key !== "above") throw new Error(`pool_overrides.${pool}.oor_exit.${key} is not supported`);
      for (const side of ["below", "above"] as const) {
        if (value[side] === undefined) continue;
        const settings = object(value[side], `pool_overrides.${pool}.oor_exit.${side}`);
        for (const key of Object.keys(settings)) if (!["enabled", "trigger_bins", "confirm_sec"].includes(key)) throw new Error(`pool_overrides.${pool}.oor_exit.${side}.${key} is not supported`);
        if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error(`pool_overrides.${pool}.oor_exit.${side}.enabled must be boolean`);
        if (settings.trigger_bins !== undefined) integer(settings.trigger_bins, `pool_overrides.${pool}.oor_exit.${side}.trigger_bins`, 1);
        if (settings.confirm_sec !== undefined) number(settings.confirm_sec, `pool_overrides.${pool}.oor_exit.${side}.confirm_sec`, 0);
      }
    }
  }
  for (const key of ["enabled", "close_empty_token_account"]) if (typeof swap[key] !== "boolean") throw new Error(`swap.${key} must be boolean`);
  if (swap.output !== "SOL") throw new Error("swap.output must be SOL");
  number(swap.min_value_usd, "swap.min_value_usd", 0);
  integer(swap.slippage_bps, "swap.slippage_bps", 1);
  integer(swap.max_slippage_bps, "swap.max_slippage_bps", swap.slippage_bps);
  if (swap.max_slippage_bps > 10_000) throw new Error("swap.max_slippage_bps cannot exceed 10000");
  integer(swap.max_retries, "swap.max_retries", 1);
  if (swap.max_retries > 3) throw new Error("swap.max_retries cannot exceed 3");
  if (swap.close_empty_token_account) throw new Error("swap.close_empty_token_account is not implemented yet");
  if (typeof trending.enabled !== "boolean") throw new Error("top_trending.enabled must be boolean");
  integer(trending.limit, "top_trending.limit", 1);
  if (trending.limit > 100) throw new Error("top_trending.limit cannot exceed 100");
  for (const key of ["min_market_cap_usd", "min_token_age_hours", "max_token_age_days", "min_holders", "min_tvl_usd", "min_organic_score"]) number(trending[key], `top_trending.${key}`, 0);
  integer(trending.min_holders, "top_trending.min_holders", 0);
  if (trending.min_organic_score > 100) throw new Error("top_trending.min_organic_score cannot exceed 100");
  if (trending.max_token_age_days * 24 < trending.min_token_age_hours) throw new Error("top_trending.max_token_age_days is below minimum age");
  if (swap.enabled && (!config.jupiter?.base_url || !config.jupiter?.tokens_base_url)) throw new Error("Jupiter URLs are required when swaps are enabled");
  if (typeof config.jupiter?.base_url !== "string" || typeof config.jupiter?.tokens_base_url !== "string") throw new Error("config.jupiter URLs are required");
  if (typeof indicator.enabled !== "boolean") throw new Error("indicator_exit.enabled must be boolean");
  if (oor.evaluation !== "live") throw new Error("oor_exit.evaluation must be live");
  integer(execution.max_retries, "execution.max_retries", 1);
  if (execution.max_retries > 3) throw new Error("execution.max_retries cannot exceed 3");
  const priorityFee = object(execution.priority_fee, "execution.priority_fee");
  if (priorityFee.mode !== "fixed") throw new Error("execution.priority_fee.mode must be fixed");
  integer(priorityFee.microlamports, "execution.priority_fee.microlamports", 0);
  integer(priorityFee.max_cap_microlamports, "execution.priority_fee.max_cap_microlamports", 0);
  if (priorityFee.microlamports > priorityFee.max_cap_microlamports) throw new Error("priority fee cannot exceed its configured cap");
  number(notify.low_sol_balance_alert_sol, "notify.low_sol_balance_alert_sol", 0);
  if (typeof heartbeat.enabled !== "boolean") throw new Error("notify.heartbeat.enabled must be boolean");
  if (typeof heartbeat.at_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(heartbeat.at_time)) throw new Error("notify.heartbeat.at_time must use HH:mm");
  if (typeof history.enabled !== "boolean" || typeof history.record_dry_run_trades !== "boolean") throw new Error("history enablement flags must be boolean");
  if (!history.enabled) throw new Error("history.enabled must remain true while position execution is enabled");
  if (mode.dry_run && !history.record_dry_run_trades) throw new Error("history.record_dry_run_trades must be true in dry-run mode");
  integer(history.snapshot_interval_sec, "history.snapshot_interval_sec", 1);
  integer(history.snapshot_retention_days, "history.snapshot_retention_days", 1);
  integer(history.candle_audit_retention_days, "history.candle_audit_retention_days", 1);
  integer(history.context_candles, "history.context_candles", 1);
  if (!Array.isArray(history.post_exit_marks_min) || history.post_exit_marks_min.some((value: unknown) => !Number.isInteger(value) || (value as number) <= 0)) throw new Error("history.post_exit_marks_min must be positive integers");
  if (typeof csv.enabled !== "boolean" || typeof csv.dir !== "string" || !csv.dir || typeof csv.file !== "string" || !csv.file) throw new Error("history.csv_export is invalid");
  if (typeof backup.enabled !== "boolean" || typeof backup.dir !== "string" || !backup.dir || typeof backup.at_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(backup.at_time)) throw new Error("history.backup is invalid");
  integer(backup.keep, "history.backup.keep", 1);
  if (typeof config.logging?.level !== "string") throw new Error("logging.level is required");
  for (const [provider, settings] of Object.entries(object(candles.providers, "candles.providers"))) {
    if (provider === "meteora" || provider === "geckoterminal") {
      const value = object(settings, `candles.providers.${provider}`);
      if (typeof value.base_url !== "string") throw new Error(`candles.providers.${provider}.base_url is required`);
      try { new URL(value.base_url); } catch { throw new Error(`candles.providers.${provider}.base_url must be a valid URL`); }
    }
  }
  return config as AppConfig;
}

export { timeframes };
