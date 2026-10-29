import type { AppConfig } from "../config/config.ts";
import type { TriggerReason } from "../domain/types.ts";

export function solLamports(value: number): bigint {
  const units = Math.round(value * 1e9);
  if (!Number.isFinite(value) || !Number.isSafeInteger(units)) throw new Error("Nilai SOL tidak valid");
  return BigInt(units);
}

export function fresh(at: number, now = Date.now()): boolean {
  return Number.isSafeInteger(at) && at <= now && now - at <= 120_000;
}

export function spotRange(active: number, step: number, solIsX: boolean, minimumPercent: number): { lower: number; upper: number } {
  if (!Number.isSafeInteger(active) || !Number.isFinite(step) || step < 80 || minimumPercent <= -100 || minimumPercent >= 0) throw new Error("Range SPOT tidak valid");
  const width = -Math.ceil(Math.log1p(minimumPercent / 100) / Math.log1p(step / 10_000));
  if (width < 1 || width + 1 > 1400) throw new Error("Range tidak muat dalam satu posisi extended");
  return solIsX ? { lower: active, upper: active + width } : { lower: active - width, upper: active };
}

export function exitReason(input: {
  active: number; lower: number; upper: number; solIsX: boolean;
  principal: bigint | null; profit: bigint | null; ignored: boolean; at: number;
}, config: AppConfig["automation"], now = Date.now()): TriggerReason | undefined {
  if (input.ignored || !fresh(input.at, now) || ![input.active, input.lower, input.upper].every(Number.isSafeInteger) || input.lower > input.upper) return;
  const direction = input.solIsX ? -1 : 1;
  const low = input.solIsX ? input.upper : input.lower;
  const high = input.solIsX ? input.lower : input.upper;
  if (direction * (low - input.active) >= config.oor_below_bins) return "OOR_BELOW_BINS";
  if (input.principal !== null && input.principal > 0n && input.profit !== null &&
      input.profit * 10_000n <= -input.principal * BigInt(Math.round(config.stop_loss_percent * 100))) return "STOP_LOSS";
  if (direction * (input.active - high) >= config.oor_above_bins) return "OOR_ABOVE_BINS";
  if (input.principal !== null && input.principal > 0n && input.profit !== null &&
      input.profit * 10_000n >= input.principal * BigInt(Math.round(config.profit_percent * 100))) return "TAKE_PROFIT";
}

export function swapAllowed(valueMicrousd: bigint, minimumUsd: number): boolean {
  return valueMicrousd >= BigInt(Math.ceil(Math.max(0.2, minimumUsd) * 1e6));
}
