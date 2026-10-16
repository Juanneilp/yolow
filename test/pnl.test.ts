import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { PositionPnlMonitor } from "../src/positions/pnl.ts";
import { ActiveBinMonitor } from "../src/market-data/active-bin.ts";
import { openDatabase } from "../src/storage/db.ts";
import { createCommandHandler } from "../src/telegram/commands.ts";
import { parseConfig } from "../src/config/config.ts";

const wallet = "HKZY9sndsoaU84wy6ZYZgzauNdj49CenuTygBbEm4Dn8";
const pool = "AG1EhPjsBrkxQWkViuLXF6pQnHwfr9f9sdNneeoykcEJ";
const id = "9hEzfcJvGbPhVf6S7oYrq1qBQnzC1PZjwsZpEePXbeFd";
const sol = "So11111111111111111111111111111111111111112";

function position(overrides = {}) {
  return {
    positionAddress: id, isClosed: false, pnlSol: "-0.00018734640812834158", pnlSolPctChange: "-0.003746937210670808",
    allTimeDeposits: { total: { sol: "4.999987926" } }, allTimeWithdrawals: { total: { sol: "0" } },
    allTimeFees: { total: { sol: "0" } }, updatedAt: 1792149290, ...overrides,
  };
}

function payload(rows = [position()], page = 1, hasNext = false) {
  return Response.json({ positions: rows, page, hasNext });
}

function insertPosition(db: ReturnType<typeof openDatabase>, address = id) {
  db.prepare(`INSERT INTO positions(id,pool,token_mint,quote_mint,lower_bin_id,upper_bin_id,first_seen_at,last_checked)
    VALUES(?,?,?,?,0,10,1,1)`).run(address, pool, "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP", sol);
}

test("PnL deduplicates pools and concurrent refreshes, paginates, and respects cache/cooldown", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(url.searchParams.get("user"), wallet);
    assert.equal(url.searchParams.get("status"), "open");
    return url.searchParams.get("page") === "1" ? payload([position()], 1, true)
      : payload([position({ positionAddress: sol, pnlSol: "0", pnlSolPctChange: "0" })], 2);
  });
  const monitor = new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag");
  const [a, b] = await Promise.all([monitor.refresh([pool, pool]), monitor.refresh([pool], true)]);
  assert.equal(calls.length, 2);
  assert.equal(a.get(pool), b.get(pool));
  assert.equal(a.get(pool)?.positions.size, 2);
  assert.equal(a.get(pool)?.positions.get(id)?.deposits, 4.999987926);
  assert.equal(a.get(pool)?.positions.get(id)?.pnl, -0.00018734640812834158);
  assert.equal(a.get(pool)?.positions.get(sol)?.pnl, 0);
  await monitor.refresh([pool], true);
  assert.equal(calls.length, 2);
  now += 10_000;
  await monitor.refresh([pool]);
  assert.equal(calls.length, 2);
  await monitor.refresh([pool], true);
  assert.equal(calls.length, 4);
  now += 60_000;
  await monitor.refresh([pool]);
  assert.equal(calls.length, 6);
});

test("PnL keeps missing SOL unavailable and rejects corrupt numbers without losing cached data", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let row = position({ pnlSol: null, pnlSolPctChange: undefined });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return payload([row]); });
  const monitor = new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag");
  const first = (await monitor.refresh([pool])).get(pool)!;
  assert.equal(first.positions.get(id)?.pnl, null);
  assert.equal(first.positions.get(id)?.percent, null);
  row = position({ pnlSol: "NaN" });
  now += 60_000;
  const failed = (await monitor.refresh([pool], true)).get(pool)!;
  assert.match(failed.error!, /tidak valid/);
  assert.equal(failed.positions, first.positions);
  assert.equal(failed.fetchedAt, first.fetchedAt);
  row = position({ pnlSol: "1.25", pnlSolPctChange: "25" });
  now += 10_000;
  await monitor.refresh([pool], true);
  assert.equal(calls, 2);
  now += 50_000;
  assert.equal((await monitor.refresh([pool])).get(pool)?.positions.get(id)?.pnl, 1.25);
});

test("PnL handles timeout, HTTP 429 Retry-After, and invalid pagination without RPC fallback", async (t) => {
  let now = 1_000_000;
  let calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new DOMException("timeout", "TimeoutError");
    if (calls === 2) return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    return payload([], 1, true);
  });
  const monitor = new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag");
  const failed = (await monitor.refresh([pool])).get(pool)!;
  assert.ok(failed.error);
  assert.equal(failed.fetchedAt, undefined);
  now += 60_000;
  assert.match((await monitor.refresh([pool])).get(pool)!.error!, /429/);
  now += 60_000;
  await monitor.refresh([pool], true);
  assert.equal(calls, 2);
  now += 60_000;
  assert.match((await monitor.refresh([pool])).get(pool)!.error!, /Pagination/);
});

test("Telegram PnL command and Refresh show lifetime SOL values without any RPC calls", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  insertPosition(db);
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  t.mock.method(globalThis, "fetch", async () => payload());
  const connection = new Proxy({}, { get() { throw new Error("PnL must not access Helius"); } });
  const handler = createCommandHandler({
    db, config, connection: connection as any, wallet: new PublicKey(wallet), telegramToken: "test", chatId: "1",
    agent: { pnl: new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag") } as any,
  });
  const reply = await handler.onCommand("/pnl", []);
  assert.match(reply!.text, /4\.99998793 SOL/);
  assert.match(reply!.text, /PnL -0\.00018735 SOL/);
  assert.doesNotMatch(reply!.text, /USDC|USD|DRY-RUN|LIVE/);
  assert.equal(reply!.replyMarkup!.inline_keyboard[0][0].callback_data, "cmd:/pnl");
  assert.equal((await handler.onCallback("cmd:/pnl"))!.text, reply!.text);
  assert.equal(config.mode.position_poll_interval_sec, 300);
  assert.equal(config.history.snapshot_interval_sec, 300);
  assert.equal(config.rpc.oor_fallback_poll_interval_sec, 15);
});

test("OOR fallback reads one account per pool every 15 seconds and rejects stale/invalid data", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  insertPosition(db);
  insertPosition(db, sol);
  let now = 1_000_000;
  let calls = 0;
  let activeId: unknown = 5;
  let fails = false;
  let triggers = 0;
  t.mock.method(Date, "now", () => now);
  const monitor = new ActiveBinMonitor({
    db, connection: { _rpcWebSocketConnected: false, getAccountInfo: async () => {
      calls++;
      if (fails) throw new Error("offline");
      return { data: Buffer.alloc(0) };
    } } as any,
    fallbackPollMs: 15_000, below: { enabled: true, trigger_bins: 1, confirm_sec: 0 },
    above: { enabled: true, trigger_bins: 1, confirm_sec: 0 }, poolOverrides: {},
    onTrigger: async () => { triggers++; return 0; },
  });
  const state = {
    client: { program: { coder: { accounts: { decode: () => ({ activeId }) } } }, getActiveBin: () => { throw new Error("Expensive bin fetch"); } },
    activeBin: 5, lastUpdate: now, lastPollAt: 0, storedBin: 5, storedAt: now,
  };
  (monitor as any).pools.set(pool, state);
  t.mock.method(console, "warn", () => {});
  await (monitor as any).tick();
  assert.equal(calls, 1);
  now += 14_999;
  await (monitor as any).tick();
  assert.equal(calls, 1);
  now++;
  activeId = "invalid";
  await (monitor as any).tick();
  assert.equal(calls, 2);
  assert.equal(state.activeBin, 5);
  fails = true;
  state.activeBin = 20;
  now += 16_000;
  await (monitor as any).tick();
  assert.equal(triggers, 0);
  fails = false;
  activeId = 20;
  now += 15_000;
  await (monitor as any).tick();
  assert.equal(triggers, 2);
});
