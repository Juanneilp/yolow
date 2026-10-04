import type { Candle } from "../domain/types.ts";

export type IndicatorValues = { rsi?: number; bbUpper?: number; macdHist?: number; macdPreviousHist?: number };
export type IndicatorConfig = {
  indicators?: {
    rsi?: { period?: number; overbought?: number };
    bb?: { period?: number; std_dev?: number };
    macd?: { fast?: number; slow?: number; signal?: number };
  };
  rule?: { rsi_required?: boolean; confirmations_any_of?: string[] };
};

export function rsiWilder(closes: number[], period = 2): number | undefined {
  if (closes.length < period + 1) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function bollingerUpper(closes: number[], period = 20, deviations = 2): number | undefined {
  if (closes.length < period) return undefined;
  const values = closes.slice(-period);
  const mean = values.reduce((sum, value) => sum + value, 0) / period;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
  return mean + deviations * Math.sqrt(variance);
}

function emaSeries(values: number[], period: number): Array<number | undefined> {
  const result: Array<number | undefined> = Array(values.length);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = previous;
  for (let i = period; i < values.length; i += 1) {
    previous = (values[i] - previous) * multiplier + previous;
    result[i] = previous;
  }
  return result;
}

export function macdHistogram(closes: number[], fast = 12, slow = 26, signal = 9): number[] {
  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);
  const macd: Array<number | undefined> = closes.map((_, i) => fastEma[i] === undefined || slowEma[i] === undefined ? undefined : fastEma[i]! - slowEma[i]!);
  const start = macd.findIndex((value) => value !== undefined);
  if (start < 0) return [];
  const compactMacd = macd.slice(start).map((value) => value!);
  const signalEma = emaSeries(compactMacd, signal);
  return compactMacd.flatMap((value, i) => signalEma[i] === undefined ? [] : [value - signalEma[i]!]);
}

export function calculateIndicators(candles: Candle[], config: IndicatorConfig = {}): IndicatorValues {
  const closes = candles.map((candle) => candle.close);
  const rsiPeriod = config.indicators?.rsi?.period ?? 2;
  const bbPeriod = config.indicators?.bb?.period ?? 20;
  const bbStdDev = config.indicators?.bb?.std_dev ?? 2;
  const hist = macdHistogram(closes, config.indicators?.macd?.fast ?? 12,
    config.indicators?.macd?.slow ?? 26, config.indicators?.macd?.signal ?? 9);
  return {
    rsi: rsiWilder(closes, rsiPeriod),
    bbUpper: bollingerUpper(closes, bbPeriod, bbStdDev),
    macdHist: hist.at(-1),
    macdPreviousHist: hist.at(-2),
  };
}

export function indicatorExitSignal(candles: Candle[], config: IndicatorConfig = {}): IndicatorValues & { fired: boolean } {
  const current = candles.at(-1);
  const values = calculateIndicators(candles, config);
  const confirmations = config.rule?.confirmations_any_of ?? ["bb_breakout", "macd_first_green"];
  const rsiRequired = config.rule?.rsi_required ?? true;
  const confirmed = confirmations.some((confirmation) => confirmation === "bb_breakout"
    ? values.bbUpper !== undefined && !!current && current.close > values.bbUpper
    : confirmation === "macd_first_green"
      ? values.macdHist !== undefined && values.macdPreviousHist !== undefined && values.macdHist > 0 && values.macdPreviousHist <= 0
      : false);
  return {
    ...values,
    fired: !!current && (!rsiRequired || (values.rsi !== undefined && values.rsi > (config.indicators?.rsi?.overbought ?? 90))) && confirmed,
  };
}
