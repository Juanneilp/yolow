import type { AppConfig } from "../config/config.ts";
import type { Candle, Timeframe } from "../domain/types.ts";
import type { DatabaseSync } from "node:sqlite";
import { readJsonResponse, safeError } from "../security.ts";

const durationMs: Record<Timeframe, number> = { "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000 };
const SOL_MINT = "So11111111111111111111111111111111111111112";
const METEORA_MAX_RANGE_SEC = 8 * 60 * 60;
let geckoQueue: Promise<void> = Promise.resolve();
let geckoNextRequestAt = 0;

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function json(url: URL, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readJsonResponse(response);
}

function geckoJson(url: URL): Promise<any> {
  const request = geckoQueue.then(async () => {
    const delay = Math.max(0, geckoNextRequestAt - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    geckoNextRequestAt = Date.now() + 6_100;
    return json(url, { Accept: "application/json;version=20230203" });
  });
  geckoQueue = request.then(() => undefined, () => undefined);
  return request;
}

function normalizeRows(raw: any, provider: string, unit: "usd" | "sol"): Candle[] {
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.data) ? raw.data
      : Array.isArray(raw?.data?.candles) ? raw.data.candles
        : Array.isArray(raw?.candles) ? raw.candles
          : Array.isArray(raw?.data?.ohlcv) ? raw.data.ohlcv
            : undefined;
  if (!rows) throw new Error("respons candle tidak berisi array");
  const result: Candle[] = [];
  for (const row of rows) {
    let time: number | undefined;
    let open: number | undefined;
    let high: number | undefined;
    let low: number | undefined;
    let close: number | undefined;
    let volume: number | undefined;
    if (Array.isArray(row)) {
      [time, open, high, low, close, volume] = row.map(number) as [number, number, number, number, number, number];
    } else {
      time = number(row.timestamp ?? row.open_time ?? row.time);
      if (time === undefined && typeof row.timestamp_str === "string") time = Date.parse(row.timestamp_str) / 1000;
      open = number(row.open);
      high = number(row.high);
      low = number(row.low);
      close = number(row.close);
      volume = number(row.volume ?? row.volume_usd) ?? 0;
    }
    if (time === undefined || open === undefined || high === undefined || low === undefined || close === undefined) continue;
    const openTime = time < 100_000_000_000 ? time * 1000 : time;
    if (Math.min(open, high, low, close) <= 0) continue;
    result.push({ time: openTime, open, high, low, close, volume: volume ?? 0, provider, unit });
  }
  return result.sort((a, b) => a.time - b.time);
}

function aggregateCandles(candles: Candle[], interval: number, sourceInterval: number): Candle[] {
  const expected = interval / sourceInterval;
  const groups = new Map<number, Candle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / interval) * interval;
    const group = groups.get(bucket) ?? [];
    group.push(candle);
    groups.set(bucket, group);
  }
  return [...groups.entries()].flatMap(([time, group]) => {
    group.sort((a, b) => a.time - b.time);
    if (group.length !== expected || group.some((candle, index) => candle.time !== time + index * sourceInterval)) return [];
    return [{
      ...group[0], time, high: Math.max(...group.map((item) => item.high)),
      low: Math.min(...group.map((item) => item.low)), close: group.at(-1)!.close,
      volume: group.reduce((sum, item) => sum + item.volume, 0),
    }];
  });
}

function fillGaps(candles: Candle[], interval: number): Candle[] {
  const result: Candle[] = [];
  for (const candle of candles) {
    const previous = result.at(-1);
    if (previous) {
      for (let time = previous.time + interval; time < candle.time; time += interval) {
        result.push({ ...previous, time, open: previous.close, high: previous.close, low: previous.close, close: previous.close, volume: 0 });
      }
    }
    result.push(candle);
  }
  return result;
}

async function fetchProvider(provider: string, pool: string, timeframe: Timeframe, config: AppConfig, now: number): Promise<Candle[]> {
  const base = provider === "meteora" ? config.candles.providers.meteora?.base_url
    : provider === "geckoterminal" ? config.candles.providers.geckoterminal?.base_url
      : undefined;
  if (!base) throw new Error(`${provider} candle endpoint belum dikonfigurasi`);
  const interval = durationMs[timeframe];
  const start = Math.floor((now - interval * config.candles.backfill_candles) / 1000);
  const end = Math.floor(now / 1000);
  let result: Candle[];
  if (provider === "meteora") {
    const byTime = new Map<number, Candle>();
    // Meteora rejects large time ranges; split the requested history into safe 8h windows.
    for (let chunkStart = start; chunkStart < end; chunkStart += METEORA_MAX_RANGE_SEC) {
      const url = new URL(`/pools/${encodeURIComponent(pool)}/ohlcv`, base);
      url.searchParams.set("timeframe", timeframe === "15m" ? "5m" : timeframe);
      url.searchParams.set("start_time", String(chunkStart));
      url.searchParams.set("end_time", String(Math.min(chunkStart + METEORA_MAX_RANGE_SEC, end)));
      const rows = normalizeRows(await json(url), provider, config.candles.price_unit);
      for (const candle of rows) byTime.set(candle.time, candle);
    }
    result = [...byTime.values()].sort((a, b) => a.time - b.time);
  } else {
    const aggregate = timeframe === "1h" ? 60 : timeframe === "30m" ? 15 : Number.parseInt(timeframe, 10);
    const url = new URL(`${base.replace(/\/+$/, "")}/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${aggregate === 60 ? "hour" : "minute"}`);
    url.searchParams.set("aggregate", String(aggregate === 60 ? 1 : aggregate));
    const sourceCandles = timeframe === "30m" ? config.candles.backfill_candles * 2 : config.candles.backfill_candles;
    url.searchParams.set("limit", String(Math.min(sourceCandles, 1000)));
    url.searchParams.set("before_timestamp", String(end));
    url.searchParams.set("currency", config.candles.price_unit === "usd" ? "usd" : "token");
    if (config.candles.price_unit === "sol") url.searchParams.set("token", SOL_MINT);
    const body = await geckoJson(url);
    const rows = body?.data?.attributes?.ohlcv_list;
    result = normalizeRows(rows, provider, config.candles.price_unit);
  }
  if (provider === "meteora" && timeframe === "15m") result = aggregateCandles(fillGaps(result, 300_000), 900_000, 300_000);
  if (provider === "geckoterminal" && timeframe === "30m") result = aggregateCandles(fillGaps(result, 900_000), 1_800_000, 900_000);
  result = fillGaps(result, interval);
  const finalBefore = now - config.candles.grace_window_sec * 1000;
  const finalized = result.filter((candle) => candle.time + interval <= finalBefore).slice(-config.candles.backfill_candles);
  if (finalized.length === 0) throw new Error("provider tidak mengembalikan candle finalized");
  return finalized;
}

export async function fetchCandleSeries(pool: string, timeframe: Timeframe, config: AppConfig, now = Date.now()): Promise<Candle[]> {
  const providers = [config.candles.primary, ...config.candles.fallback_chain].filter((name, index, all) => all.indexOf(name) === index);
  const errors: string[] = [];
  for (const provider of providers) {
    if (provider === "gmgn" || provider === "onchain_ticks") {
      errors.push(`${provider}: provider memerlukan integrasi khusus`);
      continue;
    }
    try {
      return await fetchProvider(provider, pool, timeframe, config, now);
    } catch (error) {
      errors.push(`${provider}: ${safeError(error)}`);
    }
  }
  throw new Error(`Semua sumber candle gagal: ${errors.join("; ")}`);
}

export async function fetchCandleAt(pool: string, timeframe: Timeframe, config: AppConfig, at: number): Promise<Candle> {
  const interval = durationMs[timeframe];
  const target = Math.floor(at / interval) * interval;
  const fetchAt = target + interval + config.candles.grace_window_sec * 1000 + 1_000;
  const providers = [config.candles.primary, ...config.candles.fallback_chain].filter((name, index, all) => all.indexOf(name) === index);
  const errors: string[] = [];
  for (const provider of providers) {
    if (provider === "gmgn" || provider === "onchain_ticks") continue;
    try {
      const candles = await fetchProvider(provider, pool, timeframe, config, fetchAt);
      const candle = candles.find((item) => item.time === target);
      if (candle) return candle;
      errors.push(`${provider}: candle ${new Date(target).toISOString()} tidak tersedia`);
    } catch (error) { errors.push(`${provider}: ${safeError(error)}`); }
  }
  throw new Error(errors.join("; ") || "Tidak ada sumber candle historis yang aktif");
}

export function saveCandles(db: DatabaseSync, candles: Candle[], assetKey: string, timeframe: Timeframe): void {
  const save = db.prepare(`INSERT INTO candles(provider,asset_key,timeframe,unit,open_time,open,high,low,close,volume)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,asset_key,timeframe,unit,open_time) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`);
  for (const candle of candles) save.run(candle.provider, assetKey, timeframe, candle.unit, candle.time,
    candle.open, candle.high, candle.low, candle.close, candle.volume);
}

export function loadCandles(db: DatabaseSync, assetKey: string, timeframe: Timeframe, unit: string, provider: string, limit: number): Candle[] {
  return (db.prepare(`SELECT provider,open_time AS time,open,high,low,close,volume,unit FROM candles
    WHERE asset_key=? AND timeframe=? AND unit=? AND provider=? ORDER BY open_time DESC LIMIT ?`).all(assetKey, timeframe, unit, provider, limit) as Array<any>)
    .reverse().map((row) => ({ ...row, time: Number(row.time) }));
}
