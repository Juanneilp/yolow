import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { distance } from "../src/market-data/active-bin.ts";
import { fetchCandleSeries } from "../src/market-data/candles.ts";
import { indicatorExitSignal, macdHistogram, rsiWilder } from "../src/market-data/indicators.ts";
import type { Position } from "../src/domain/types.ts";
import { OorExitEngine } from "../src/triggers/oor-exit.ts";
import { formatExitTimestamp, simulateLegacyTransaction } from "../src/execution/executor.ts";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";

function stubRpc(connection: Connection): void {
  (connection as unknown as { _rpcRequest: (method: string) => Promise<unknown> })._rpcRequest = async (method: string) => {
    const base = { jsonrpc: "2.0", id: "test" };
    if (method === "getLatestBlockhash") {
      return { ...base, result: { context: { slot: 100 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999 } } };
    }
    if (method === "simulateTransaction") {
      return { ...base, result: { context: { slot: 100 }, value: { err: null, logs: [], unitsConsumed: 1000 } } };
    }
    throw new Error(`unexpected rpc method ${method}`);
  };
}

function legacyTransaction(): Transaction {
  const payer = Keypair.generate().publicKey;
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  return tx;
}

const position: Position = {
  id: "position-1", pool: "pool-1", tokenMint: "token-1", quoteMint: "sol",
  lowerBinId: 100, upperBinId: 120, firstSeenAt: 0, ignored: false, state: "OPEN",
};

test("OOR uses range boundaries, continuous confirmation, and resets below threshold", () => {
  const engine = new OorExitEngine();
  const below = { enabled: true, trigger_bins: 20, confirm_sec: 5 };
  const above = { enabled: true, trigger_bins: 20, confirm_sec: 30 };

  assert.deepEqual(distance(position, 80), { below: 20, above: -40 });
  assert.equal(engine.update(position, 79, 1_000, below, above), undefined);
  assert.equal(engine.update(position, 81, 3_000, below, above), undefined);
  assert.equal(engine.update(position, 79, 5_000, below, above), undefined);
  const trigger = engine.update(position, 80, 10_000, below, above);
  assert.equal(trigger?.reason, "OOR_BELOW");
  assert.equal(trigger?.detectedAt, 5_000);
  assert.equal(trigger?.confirmedAt, 10_000);
  assert.equal(trigger?.detail.belowDistance, 20);
});

test("OOR closes immediately above range when confirmation is zero and ignores ignored positions", () => {
  const engine = new OorExitEngine();
  const config = { enabled: true, trigger_bins: 20, confirm_sec: 0 };
  assert.equal(engine.update({ ...position, ignored: true }, 140, 1_000, config, config), undefined);
  assert.equal(engine.update(position, 140, 2_000, { ...config, enabled: false }, config)?.reason, "OOR_ABOVE");
});

test("exit timestamp includes weekday, date, and local hour and minute", () => {
  assert.equal(formatExitTimestamp(Date.UTC(2026, 9, 4, 0, 0), "Asia/Jakarta"), "Minggu, 4 Oktober 2026 pukul 07.00 WIB");
});

test("indicator math handles readiness, Wilder RSI, MACD warm-up, and same-candle confirmation", () => {
  assert.equal(rsiWilder([1, 2], 2), undefined);
  assert.equal(rsiWilder([1, 2, 3], 2), 100);
  assert.equal(rsiWilder([5, 5, 5], 2), 50);
  const histogram = macdHistogram(Array.from({ length: 50 }, (_, index) => 100 + index));
  assert.ok(histogram.length > 0 && histogram.every(Number.isFinite));

  const candles = [1, 2].map((close, index) => ({
    time: index * 300_000, open: close, high: close, low: close,
    close, volume: 1, provider: "test", unit: "usd" as const,
  }));
  const signal = indicatorExitSignal(candles, {
    indicators: { rsi: { period: 1, overbought: 90 }, bb: { period: 2, std_dev: 0 } },
    rule: { rsi_required: true, confirmations_any_of: ["bb_breakout"] },
  });
  assert.equal(signal.fired, true);
  assert.equal(signal.rsi, 100);
  assert.equal(signal.bbUpper, 1.5);
});

test("live close simulation uses the legacy-compatible call and never passes a config object", async () => {
  const connection = new Connection("https://mainnet.helius-rpc.com", "confirmed");
  stubRpc(connection);
  const tx = legacyTransaction();

  // Regression: @solana/web3.js 1.98.4 throws "Invalid arguments" for simulateTransaction(legacyTx, { config }).
  await assert.rejects(
    () => connection.simulateTransaction(tx, { commitment: "confirmed" }),
    /Invalid arguments/,
    "web3.js must reject a config object for legacy transactions; the helper exists because of this",
  );

  // The helper must simulate the same legacy transaction without throwing and report CU usage.
  assert.equal(await simulateLegacyTransaction(connection, tx), 1000);
});

test("legacy simulation surfaces a failed simulation error", async () => {
  const connection = new Connection("https://mainnet.helius-rpc.com", "confirmed");
  (connection as unknown as { _rpcRequest: (method: string) => Promise<unknown> })._rpcRequest = async (method: string) => {
    const base = { jsonrpc: "2.0", id: "test" };
    if (method === "getLatestBlockhash") {
      return { ...base, result: { context: { slot: 100 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999 } } };
    }
    return { ...base, result: { context: { slot: 100 }, value: { err: { InstructionError: [0, "Custom"] }, logs: [], unitsConsumed: 1000 } } };
  };
  await assert.rejects(() => simulateLegacyTransaction(connection, legacyTransaction()), /Simulasi gagal/);
});

test("Meteora candle history is chunked and 5m rows aggregate to finalized 15m candles", async () => {
  const config = JSON.parse(await readFile("config.example.json", "utf8"));
  config.candles.primary = "meteora";
  config.candles.fallback_chain = [];
  config.candles.backfill_candles = 40;
  config.candles.grace_window_sec = 0;
  const now = Date.parse("2026-01-01T12:00:00Z");
  const timestamps = [-30, -25, -20, -15, -10, -5].map((minutes) => Math.floor(now / 1000) + minutes * 60);
  const requested: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url);
    const start = Number(url.searchParams.get("start_time"));
    const end = Number(url.searchParams.get("end_time"));
    const rows = timestamps.flatMap((timestamp, index) => timestamp < start || timestamp > end ? [] : [{
      timestamp, open: 100 + index, high: 101 + index, low: 99 + index,
      close: 100.5 + index, volume: 1,
    }]);
    return new Response(JSON.stringify({ data: rows }), { status: 200 });
  }) as typeof fetch;

  try {
    const candles = await fetchCandleSeries("pool-1", "15m", config, now);
    assert.equal(requested.length, 2);
    assert.ok(requested.every((url) => url.searchParams.get("timeframe") === "5m"));
    assert.deepEqual(candles.map((candle) => candle.time), [now - 30 * 60_000, now - 15 * 60_000]);
    assert.equal(candles[0].open, 100);
    assert.equal(candles[0].high, 103);
    assert.equal(candles[0].low, 99);
    assert.equal(candles[0].close, 102.5);
    assert.equal(candles[0].volume, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
