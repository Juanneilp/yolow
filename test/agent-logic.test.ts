import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fetchCandleSeries } from "../src/market-data/candles.ts";
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

test("exit timestamp includes weekday, date, and local hour and minute", () => {
  assert.equal(formatExitTimestamp(Date.UTC(2026, 9, 4, 0, 0), "Asia/Jakarta"), "Minggu, 4 Oktober 2026 pukul 07.00 WIB");
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
