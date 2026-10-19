import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { PositionPnlMonitor } from "../src/positions/pnl.ts";
import { ActiveBinMonitor } from "../src/market-data/active-bin.ts";
import { openDatabase } from "../src/storage/db.ts";
import { createCommandHandler } from "../src/telegram/commands.ts";
import { parseConfig } from "../src/config/config.ts";
import { YolowAgent } from "../src/agent.ts";

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

test("profit reminders repeat on schedule, filter fresh open profits, and hot apply settings", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const ids = Array.from({ length: 8 }, (_, i) => new PublicKey(Buffer.alloc(32, i + 30)).toBase58());
  for (const address of ids) insertPosition(db, address);
  db.prepare("UPDATE positions SET ignored=1 WHERE id=?").run(ids[1]);
  db.prepare("UPDATE positions SET state='CLOSED' WHERE id=?").run(ids[2]);
  const data = new Map(ids.map((address, i) => [address, {
    id: address, pnl: i === 5 ? -1 : i === 7 ? null : 1, percent: [6, 9, 20, 5, 4.99, 10, null, 8][i],
    deposits: 1, withdrawals: 0, claimed: 0, updatedAt: 1,
  }]));
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  const noRpc = new Proxy({}, { get() { throw new Error("No RPC"); } }) as any;
  const agent = new YolowAgent({ db, config, connection: noRpc, wallet: new PublicKey(wallet), telegramToken: "123456:test-token", chatId: "1" });
  let result: any;
  t.mock.method(agent.pnl, "refresh", async (pools: string[]) => {
    assert.deepEqual([...new Set(pools)], [pool]);
    return new Map([[pool, result ?? { fetchedAt: now, positions: data }]]);
  });
  const sent: string[] = [];
  let telegramFails = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    assert.match(String(input), /\/sendMessage$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, "1");
    sent.push(body.text);
    return Response.json({ ok: !telegramFails }, { status: telegramFails ? 500 : 200 });
  });
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  const tick = () => (agent as any).refreshPnl();
  await tick();
  assert.equal(sent.length, 0);
  now += 299_999;
  await tick();
  assert.equal(sent.length, 0);
  now++;
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /2 posisi · PnL > 5% · interval 5 menit/);
  assert.match(sent[0], /\+1\.00000000 SOL \(\+9\.0000%\)/);
  assert.ok(sent[0].indexOf("+9.0000%") < sent[0].indexOf("+6.0000%"));
  assert.doesNotMatch(sent[0], /\+20\.0000%|\+5\.0000%|\+4\.9900%|\+10\.0000%|\+8\.0000%/);
  await tick();
  assert.equal(sent.length, 1);
  const handler = createCommandHandler({ db, config, connection: noRpc, wallet: new PublicKey(wallet), telegramToken: "test", chatId: "1", agent });
  await handler.onCommand("/positions", []);
  assert.equal(sent.length, 1);
  now += 300_000;
  await tick();
  assert.equal(sent.length, 2);
  config.notify.profit_alert.interval_minutes = 1;
  config.notify.profit_alert.threshold_percent = 8;
  now += 60_000;
  await tick();
  assert.equal(sent.length, 3);
  assert.match(sent[2], /1 posisi · PnL > 8% · interval 1 menit/);
  config.notify.profit_alert.enabled = false;
  now += 60_000;
  await tick();
  assert.equal(sent.length, 3);
  config.notify.profit_alert.enabled = true;
  for (const bad of [{ fetchedAt: now, positions: data, error: "offline" }, { fetchedAt: now - 180_001, positions: data }, { positions: data }]) {
    result = bad;
    now += 60_000;
    await tick();
    assert.equal(sent.length, 3);
  }
  result = undefined;
  telegramFails = true;
  now += 60_000;
  await tick();
  assert.equal(sent.length, 4);
  assert.equal(warnings.length, 1);
  await tick();
  assert.equal(sent.length, 4);
  telegramFails = false;
  now += 60_000;
  await tick();
  assert.equal(sent.length, 5);
  db.prepare("UPDATE positions SET state='CLOSED' WHERE id=?").run(ids[1]);
  now += 60_000;
  await tick();
  assert.equal(sent.length, 5);
  (agent as any).stopped = true;
  await tick();
  assert.equal(sent.length, 5);
});

test("profit summaries split long lists without dropping positions and cancel closed positions during labels", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const ids = Array.from({ length: 80 }, (_, i) => new PublicKey(Buffer.alloc(32, i + 80)).toBase58());
  for (const address of ids) insertPosition(db, address);
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  const agent = new YolowAgent({ db, config, connection: {} as any, wallet: new PublicKey(wallet), telegramToken: "123456:test-token", chatId: "1", jupiterApiKey: "test-key" });
  t.mock.method(agent.pnl, "refresh", async () => new Map([[pool, { fetchedAt: now, positions: new Map(ids.map((address) => [address, {
    id: address, pnl: 1, percent: 6, deposits: 1, withdrawals: 0, claimed: 0, updatedAt: null,
  }])) }]]));
  const sent: string[] = [];
  let closeDuringLabels = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes("/tokens/v2/search")) {
      if (closeDuringLabels) db.prepare("UPDATE positions SET state='CLOSED'").run();
      return Response.json([], { status: 503 });
    }
    assert.match(String(input), /\/sendMessage$/);
    sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true });
  });
  await (agent as any).refreshPnl();
  now += 300_000;
  await (agent as any).refreshPnl();
  assert.ok(sent.length > 1);
  assert.equal((sent.join("\n").match(/🟢 PnL/g) ?? []).length, 80);
  for (const [i, message] of sent.entries()) {
    assert.ok(message.length <= 3500);
    assert.ok(message.includes(`Bagian ${i + 1}/${sent.length}`));
    assert.match(message, /80 posisi/);
  }
  const count = sent.length;
  closeDuringLabels = true;
  now += 300_000;
  await (agent as any).refreshPnl();
  assert.equal(sent.length, count);
});

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
  assert.match(reply!.text, /POSISI &amp; PnL/);
  assert.match(reply!.text, /−0\.00018735 SOL/);
  assert.doesNotMatch(reply!.text, /USDC|USD|DRY-RUN|LIVE/);
  assert.equal(reply!.replyMarkup!.inline_keyboard[0][0].callback_data, `position:view:${id}`);
  assert.match((await handler.onCallback(`position:view:${id}`))!.text, /4\.99998793 SOL/);
  assert.equal((await handler.onCommand("/positions", []))!.text, reply!.text);
  assert.equal((await handler.onCallback("cmd:/pnl"))!.text, reply!.text);
  assert.equal(config.mode.position_poll_interval_sec, 300);
  assert.equal(config.history.snapshot_interval_sec, 300);
  assert.equal(config.rpc.oor_fallback_poll_interval_sec, 15);
});

test("combined positions sort profits first, paginate five cards, and keep unknown PnL last", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  t.mock.method(Date, "now", () => 1_000_000);
  const ids = Array.from({ length: 9 }, (_, i) => new PublicKey(Buffer.alloc(32, i + 1)).toBase58());
  const values = [null, "-0.5", "1", "0", "0.000000000001", "3", "-0.000000000001", "1"];
  for (const [i, address] of ids.entries()) {
    insertPosition(db, address);
    db.prepare("UPDATE positions SET first_seen_at=?,ignored=? WHERE id=?").run(i + 1, i === 5 ? 1 : 0, address);
  }
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return payload(values.map((value, i) => position({ positionAddress: ids[i], pnlSol: value, pnlSolPctChange: value }))); });
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  const handler = createCommandHandler({ db, config, connection: new Proxy({}, { get() { throw new Error("No RPC"); } }) as any,
    wallet: new PublicKey(wallet), telegramToken: "test", chatId: "1", agent: { pnl: new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag") } as any });
  const first = (await handler.onCommand("/positions", []))!;
  assert.match(first.text, /PnL terhitung 7\/9/);
  assert.match(first.text, /\+4\.50000000 SOL/);
  assert.match(first.text, /Exit aktif 8 · Diabaikan 1/);
  assert.match(first.text, /\+&lt;0\.00000001 SOL/);
  assert.match(first.text, /Halaman 1\/2/);
  assert.deepEqual(first.replyMarkup!.inline_keyboard.slice(0, 5).map((row: any) => row[0].callback_data),
    [5, 2, 7, 4, 3].map((i) => `position:view:${ids[i]}`));
  const second = (await handler.onCallback("positions:page:1"))!;
  assert.deepEqual(second.replyMarkup!.inline_keyboard.slice(0, 4).map((row: any) => row[0].callback_data),
    [6, 1, 0, 8].map((i) => `position:view:${ids[i]}`));
  assert.match(second.text, /−&lt;0\.00000001 SOL/);
  assert.match(second.text, /Belum tersedia/);
  assert.match(second.text, /Halaman 2\/2/);
  assert.equal((await handler.onCallback("positions:page:999"))!.text, second.text);
  assert.equal((await handler.onCallback("cmd:/pnl"))!.text, first.text);
  assert.equal(calls, 1);
  for (const reply of [first, second]) {
    assert.ok(reply.text.length < 3500);
    for (const button of reply.replyMarkup!.inline_keyboard.flat()) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test("position details preserve all pool caches and update only the selected exit state", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  t.mock.method(Date, "now", () => 1_000_000);
  insertPosition(db); insertPosition(db, sol);
  const secondPool = new PublicKey(Buffer.alloc(32, 10)).toBase58();
  db.prepare("UPDATE positions SET pool=? WHERE id=?").run(secondPool, sol);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const requestedPool = new URL(input).pathname.split("/")[2];
    requests.push(requestedPool);
    return payload([position({ positionAddress: requestedPool === pool ? id : sol })]);
  });
  const monitor = new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag");
  const tracker = t.mock.method(monitor, "refresh");
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  const handler = createCommandHandler({ db, config, connection: {} as any, wallet: new PublicKey(wallet), telegramToken: "test", chatId: "1", agent: { pnl: monitor } as any });
  await handler.onCommand("/positions", []);
  const detail = (await handler.onCallback(`position:view:${id}`))!;
  assert.match(detail.text, /DETAIL POSISI/);
  assert.match(detail.text, /Deposit <b>4\.99998793 SOL/);
  assert.ok(detail.text.includes(`<code>${id}</code>`));
  assert.ok(detail.text.includes(`<code>${pool}</code>`));
  const ignored = (await handler.onCallback(`position:ignore:${id}`))!;
  assert.match(ignored.text, /SINYAL EXIT DIABAIKAN/);
  assert.equal(ignored.replyMarkup!.inline_keyboard[0][1].callback_data, `position:unignore:${id}`);
  assert.equal(db.prepare("SELECT ignored FROM positions WHERE id=?").get(sol)!.ignored, 0);
  assert.match((await handler.onCallback(`position:unignore:${id}`))!.text, /EXIT AKTIF/);
  await handler.onCallback(`position:refresh:${id}`);
  assert.equal(requests.length, 2);
  for (const call of tracker.mock.calls) assert.deepEqual(new Set(call.arguments[0]), new Set([pool, secondPool]));
});

test("combined view labels cached, stale, and unavailable PnL without treating missing data as zero", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  insertPosition(db);
  let now = 1_000_000;
  let calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? payload() : new Response("offline", { status: 500 }));
  const monitor = new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag");
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  const options = { db, config, connection: {} as any, wallet: new PublicKey(wallet), telegramToken: "test", chatId: "1" };
  const handler = createCommandHandler({ ...options, agent: { pnl: monitor } as any });
  const first = (await handler.onCommand("/positions", []))!;
  now += 10_000;
  const failed = (await handler.onCallback("positions:refresh:0"))!;
  assert.match(failed.text, /Pembaruan gagal · data terakhir ditampilkan/);
  assert.match(failed.text, /−0\.00018735 SOL/);
  now += 120_001;
  const cached = new Map([[pool, { positions: new Map([[id, { id, pnl: 0, percent: 0 }]]), fetchedAt: now - 120_001 }]]);
  const stale = createCommandHandler({ ...options, agent: { pnl: { refresh: async () => cached } } as any });
  assert.match((await stale.onCommand("/positions", []))!.text, /lebih dari 2 menit/);
  const unavailable = createCommandHandler({ ...options, agent: { pnl: new PositionPnlMonitor(wallet, "https://dlmm.datapi.meteora.ag") } as any });
  const empty = (await unavailable.onCommand("/positions", []))!;
  assert.match(empty.text, /PnL terhitung 0\/1/);
  assert.match(empty.text, /Belum tersedia/);
  assert.doesNotMatch(empty.text, /0\.00000000 SOL/);
  assert.match(first.text, /PnL terhitung 1\/1/);
});

test("position view handles empty lists, closed positions, and invalid page callbacks", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  const handler = createCommandHandler({ db, config, connection: {} as any, wallet: new PublicKey(wallet), telegramToken: "test", chatId: "1",
    agent: { pnl: { refresh: () => { throw new Error("No fetch for empty positions"); } } } as any });
  assert.match((await handler.onCommand("/positions", []))!.text, /Belum ada posisi terbuka/);
  insertPosition(db);
  db.prepare("UPDATE positions SET state='CLOSED'").run();
  assert.match((await handler.onCallback(`position:view:${id}`))!.text, /tidak lagi terbuka/);
  assert.match((await handler.onCallback(`position:ignore:${id}`))!.text, /tidak lagi terbuka/);
  assert.match((await handler.onCallback("positions:page:999999999999999999999999"))!.text, /tidak valid/);
});

test("position HTML escapes token names and provider errors and stays in one editable message", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const ids = Array.from({ length: 5 }, (_, i) => new PublicKey(Buffer.alloc(32, i + 20)).toBase58());
  for (const address of ids) insertPosition(db, address);
  db.prepare("UPDATE positions SET active_bin=upper_bin_id+1,bin_step=0.1").run();
  const config = parseConfig(await readFile("config.example.json", "utf8"));
  const mint = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP";
  t.mock.method(globalThis, "fetch", async () => Response.json([{ id: mint, symbol: "<".repeat(16), name: "&".repeat(32) }]));
  const cache = new Map([[pool, { fetchedAt: Date.now(), error: "&".repeat(500), positions: new Map(ids.map((address) => [address, {
    id: address, pnl: 0, percent: 0, deposits: 1, withdrawals: 0, claimed: 0, updatedAt: Date.now(),
  }])) }]]);
  const handler = createCommandHandler({ db, config, connection: {} as any, wallet: new PublicKey(wallet), telegramToken: "test", chatId: "1", jupiterApiKey: "test-key",
    agent: { pnl: { refresh: async () => cache } } as any });
  const list = (await handler.onCommand("/positions", []))!;
  const detail = (await handler.onCallback(`position:view:${ids[0]}`))!;
  for (const reply of [list, detail]) {
    assert.equal(reply.parseMode, "HTML");
    assert.ok(reply.text.length < 3500);
    assert.match(reply.text, /&lt;/);
    assert.doesNotMatch(reply.text, /<<<<|&&&&/);
    assert.match(reply.text, /0\.00000000 SOL/);
    assert.match(reply.text, /OOR atas &lt;0,01%/);
  }
  assert.match(detail.text, /&amp;/);
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
