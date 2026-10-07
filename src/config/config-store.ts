import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import type { AppConfig } from "./config.ts";
import { parseConfig } from "./config.ts";

export type ConfigUpdate = {
  config: AppConfig;
  path: string;
  oldValue: unknown;
  newValue: unknown;
  restartRequired: boolean;
};

export const editablePaths = new Set([
  "indicator_exit.enabled", "indicator_exit.timeframe", "indicator_exit.min_age_candles",
  "indicator_exit.indicators.rsi.period", "indicator_exit.indicators.rsi.overbought",
  "indicator_exit.indicators.bb.period", "indicator_exit.indicators.bb.std_dev",
  "indicator_exit.indicators.macd.fast", "indicator_exit.indicators.macd.slow", "indicator_exit.indicators.macd.signal",
  "indicator_exit.rule.rsi_required", "indicator_exit.rule.confirmations_any_of",
  "oor_exit.below.enabled", "oor_exit.below.trigger_bins", "oor_exit.below.confirm_sec",
  "oor_exit.above.enabled", "oor_exit.above.trigger_bins", "oor_exit.above.confirm_sec",
  "top_trending.enabled", "top_trending.limit", "top_trending.min_market_cap_usd",
  "top_trending.min_token_age_hours", "top_trending.max_token_age_days", "top_trending.min_holders",
  "top_trending.min_tvl_usd", "top_trending.min_organic_score", "top_trending.volume_window",
  "execution.max_retries", "execution.priority_fee.microlamports", "execution.priority_fee.max_cap_microlamports",
  "swap.enabled", "swap.min_value_usd", "swap.slippage_bps", "swap.max_slippage_bps", "swap.max_retries",
  "candles.primary", "candles.fallback_chain", "candles.price_unit", "candles.poll_interval_sec",
  "candles.grace_window_sec", "candles.backfill_candles", "candles.stale_data_pause_sec",
  "notify.low_sol_balance_alert_sol", "notify.heartbeat.enabled", "notify.heartbeat.at_time",
  "history.snapshot_interval_sec", "history.snapshot_retention_days", "history.context_candles",
  "history.csv_export.enabled", "history.backup.enabled", "history.backup.at_time", "history.backup.keep",
  "timezone", "mode.position_poll_interval_sec", "rpc.oor_fallback_poll_interval_sec",
]);

export function prepareConfigUpdate(current: AppConfig, path: string, rawValue: string): ConfigUpdate {
  const parts = path.split(".");
  if (!path || path.length > 200 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Path config tidak valid.");
  }
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new Error("Path config tidak diizinkan.");
  }
  if (parts.some((part) => /^(api[_-]?key|access[_-]?token|token|secret|private[_-]?key)$/i.test(part))) {
    throw new Error("Secret tidak dapat diubah atau ditampilkan melalui Telegram.");
  }
  if (path === "mode.dry_run" || path === "config_version") {
    throw new Error("Field ini tidak dapat diubah melalui /config.");
  }
  if (["mode.shadow_candles", "history.enabled", "history.record_dry_run_trades", "logging.level"].includes(path)) {
    throw new Error(`Field '${path}' belum diterapkan oleh runtime Yolow.`);
  }
  if (parts[0] === "pool_overrides" && !validPoolOverridePath(parts)) {
    throw new Error("Pool override hanya mendukung indicator_exit.timeframe dan oor_exit.below/above settings.");
  }

  const draft = structuredClone(current);
  const oldValue = getAtPath(draft, parts);
  if (oldValue !== undefined && isObject(oldValue) && !Array.isArray(oldValue)) {
    throw new Error("Pilih path leaf, bukan satu blok config.");
  }
  if (oldValue === undefined && parts[0] !== "pool_overrides") throw new Error(`Path '${path}' tidak ditemukan.`);

  let newValue: unknown;
  try { newValue = JSON.parse(rawValue); }
  catch {
    if (oldValue === undefined || typeof oldValue === "string") newValue = rawValue;
    else throw new Error("Nilai harus JSON valid. Contoh: true, 15, \"15m\", atau [\"meteora\"].");
  }
  if (oldValue !== undefined && Array.isArray(oldValue) !== Array.isArray(newValue)) {
    throw new Error("Jenis nilai harus sama dengan jenis config saat ini.");
  }
  if (oldValue !== undefined && !Array.isArray(oldValue) && typeof oldValue !== typeof newValue) {
    throw new Error("Jenis nilai harus sama dengan jenis config saat ini.");
  }
  if (typeof newValue === "string" && /url|http_base|ws_base/i.test(path)) {
    const endpoint = new URL(newValue);
    const hasSecret = endpoint.username || endpoint.password || [...endpoint.searchParams.keys()]
      .some((key) => /^(api[_-]?key|access[_-]?token|token|secret|key)$/i.test(key));
    if (hasSecret) throw new Error("Simpan credential di .env; config.json hanya boleh memuat endpoint tanpa secret.");
  }
  if (!editablePaths.has(path) && !(parts[0] === "pool_overrides" && validPoolOverridePath(parts))) {
    throw new Error("Path config ini tidak dapat diubah melalui Telegram.");
  }
  setAtPath(draft, parts, newValue);
  const config = parseConfig(JSON.stringify(draft));
  return { config, path, oldValue, newValue, restartRequired: configUpdateNeedsRestart(path) };
}

export function applyConfigInPlace(target: AppConfig, source: AppConfig): void {
  mergeObjects(target as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>);
}

export function configUpdateNeedsRestart(path: string): boolean {
  return path === "timezone" || path.startsWith("rpc.") || path.startsWith("jupiter.") ||
    path === "mode.position_poll_interval_sec" || path === "candles.poll_interval_sec" ||
    path === "rpc.oor_fallback_poll_interval_sec" || path === "history.snapshot_interval_sec" ||
    path.startsWith("notify.heartbeat.") || path.startsWith("history.backup.") ||
    /^candles\.providers\.(meteora|geckoterminal)\.base_url$/.test(path);
}

export async function writeConfigAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validPoolOverridePath(parts: string[]): boolean {
  if (parts.length === 4 && parts[2] === "indicator_exit" && parts[3] === "timeframe") return isPoolAddress(parts[1]);
  return parts.length === 5 && isPoolAddress(parts[1]) && parts[2] === "oor_exit" &&
    (parts[3] === "below" || parts[3] === "above") &&
    ["enabled", "trigger_bins", "confirm_sec"].includes(parts[4]);
}

function isPoolAddress(value: string | undefined): boolean {
  return !!value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function getAtPath(root: unknown, parts: string[]): unknown {
  let current: any = root;
  for (const part of parts) {
    if (!isObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function setAtPath(root: unknown, parts: string[], value: unknown): void {
  let current: any = root;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(current, part)) current[part] = {};
    current = current[part];
    if (!isObject(current) || Array.isArray(current)) throw new Error("Path config tidak menunjuk ke objek.");
  }
  current[parts.at(-1)!] = value;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object";
}

function mergeObjects(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isObject(value) && !Array.isArray(value) && isObject(current) && !Array.isArray(current)) {
      mergeObjects(current, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}
