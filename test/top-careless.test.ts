import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { fetchTopCareless, selectTopCareless, formatTopCareless, type TopCarelessConfig } from "../src/market-data/top-careless.ts";
import { parseConfig } from "../src/config/config.ts";
import { prepareConfigUpdate } from "../src/config/config-store.ts";
import { createCommandHandler } from "../src/telegram/commands.ts";
import { runBot } from "../src/telegram/bot.ts";
import { getMeta, openDatabase, setMeta } from "../src/storage/db.ts";
import { PaperAutomation } from "../src/automation/automation.ts";
import { ActiveBinMonitor } from "../src/market-data/active-bin.ts";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const sol = "So11111111111111111111111111111111111111112";
const now = Date.UTC(2026, 9, 21);
const config: TopCarelessConfig = { enabled: true, limit: 10, min_market_cap_usd: 1_000_000,
  min_token_age_days: 3, min_tvl_usd: 5000, min_organic_score: 50, min_holders: 1000,
  min_fee_active_tvl_24h_percent: 4, min_bin_step: 80, blacklisted_mints: [] };
const makePool = (n = 1, overrides = {}) => ({
  pool_address: key(n + 100), pool_type: "dlmm",
  token_x: { address: key(n), market_cap: 1_000_000, symbol: "TOKEN", name: "Token", created_at: now - 72 * 3600000, organic_score: 50, holders: 1000 },
  token_y: { address: sol, organic_score: 99 }, tvl: 5000, active_tvl: 2500, volume: 50_000,
  fee_active_tvl_ratio: 4, fee_pct: 0.1, dlmm_params: { bin_step: 80 }, base_token_holders: 1000, ...overrides,
});
const pageResponse = (data: unknown[], more = false, cursor = "next") => Response.json({ data, has_more: more, ...(more ? { after_key: cursor } : {}) });

// No RPC or signing is needed by the screening handler.
function handlerFor(db: ReturnType<typeof openDatabase>, appConfig: ReturnType<typeof parseConfig>, apiKey?: string, configPath?: string) {
  return createCommandHandler({ db, config: appConfig, configPath, jupiterApiKey: apiKey, agent: {} as any,
    connection: new Proxy({}, { get() { throw new Error("Unexpected RPC"); } }) as any,
    wallet: new PublicKey(key(50)), telegramToken: "123:test", chatId: "42" });
}

const activePosition = (id: number, pool = key(101), mint = key(1), quote = sol) => ({
  id: key(id + 150), pool, tokenMint: mint, quoteMint: quote, state: "OPEN" as const,
});

test("manual blacklist validates old configs and CA arrays without enabling a restart", async () => {
  const raw = JSON.parse(await readFile("config.example.json", "utf8"));
  delete raw.top_careless.blacklisted_mints;
  const appConfig = parseConfig(JSON.stringify(raw));
  assert.deepEqual(appConfig.top_careless.blacklisted_mints, []);
  for (const value of [null, "bad", {}, [123], ["bad"], [key(1), " bad "]]) {
    assert.throws(() => prepareConfigUpdate(appConfig, "top_careless.blacklisted_mints", JSON.stringify(value)));
  }
  const update = prepareConfigUpdate(appConfig, "top_careless.blacklisted_mints", JSON.stringify([key(1)]));
  assert.deepEqual(update.config.top_careless.blacklisted_mints, [key(1)]);
  assert.deepEqual(appConfig.top_careless.blacklisted_mints, []);
  assert.equal(update.restartRequired, false);
});

test("manual blacklist commands persist, audit, reload, and stay separate from loss blocks without API calls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yolow-blacklist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  const appConfig = parseConfig(await readFile("config.example.json", "utf8"));
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const handler = handlerFor(db, appConfig, undefined, path);
  const automation = new PaperAutomation({ db, config: appConfig } as any);
  const auditCount = () => db.prepare("SELECT count(*) n FROM config_changes").get()!.n;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network"); });
  assert.match((await handler.onCommand("/blacklist", []))!.text, /0 token/);
  for (const mint of [key(1), key(2)]) {
    assert.match((await handler.onCommand("/blacklist", ["add", mint]))!.text, /ditambahkan/);
  }
  assert.equal(auditCount(), 2);
  assert.match((await handler.onCommand("/blacklist", ["add", key(1)]))!.text, /sudah ada/);
  assert.match((await handler.onCommand("/blacklist", ["remove", key(3)]))!.text, /belum ada/);
  for (const args of [["add"], ["add", key(3), key(4)], ["remove"], ["clear"]]) {
    assert.match((await handler.onCommand("/blacklist", args))!.text, /Tambah: \/blacklist add/);
  }
  for (const action of ["add", "remove"]) {
    assert.match((await handler.onCommand("/blacklist", [action, "bad"]))!.text, /CA tidak valid/);
  }
  assert.equal(auditCount(), 2);
  const saved = await readFile(path, "utf8");
  const reloaded = parseConfig(saved);
  assert.deepEqual(reloaded.top_careless.blacklisted_mints, [key(1), key(2)]);
  const listed = (await handlerFor(db, reloaded).onCommand("/blacklist", []))!.text;
  assert.ok(listed.includes(key(1)) && listed.includes(key(2)));
  const failed = handlerFor(db, appConfig, undefined, join(directory, "missing", "config.json"));
  assert.match((await failed.onCommand("/blacklist", ["add", key(3)]))!.text, /CONFIG TIDAK DIUBAH/);
  assert.deepEqual(appConfig.top_careless.blacklisted_mints, [key(1), key(2)]);
  assert.equal(await readFile(path, "utf8"), saved);
  assert.equal(auditCount(), 2);
  db.prepare("INSERT INTO automation_blocks VALUES(?,?,?)").run(key(1), now, "OOR_BELOW_PERCENT");
  automation.unblock(key(1));
  assert.deepEqual(appConfig.top_careless.blacklisted_mints, [key(1), key(2)]);
  db.prepare("INSERT INTO automation_blocks VALUES(?,?,?)").run(key(1), now, "OOR_BELOW_PERCENT");
  assert.match((await handler.onCommand("/blacklist", ["remove", key(1)]))!.text, /dihapus/);
  assert.deepEqual(automation.blocks().map((item) => item.mint), [key(1)]);
  assert.deepEqual(appConfig.top_careless.blacklisted_mints, [key(2)]);
  assert.deepEqual(parseConfig(await readFile(path, "utf8")).top_careless.blacklisted_mints, [key(2)]);
  assert.equal(auditCount(), 3);
  const audit = db.prepare("SELECT path,old_value,new_value FROM config_changes ORDER BY id DESC LIMIT 1").get()!;
  assert.equal(audit.path, "top_careless.blacklisted_mints");
  assert.equal(audit.old_value, JSON.stringify([key(1), key(2)]));
  assert.equal(audit.new_value, JSON.stringify([key(2)]));
});

test("blacklist commands and callbacks from unauthorized chats or senders never change configuration", async (t) => {
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const appConfig = parseConfig(await readFile("config.example.json", "utf8"));
  const handler = handlerFor(db, appConfig);
  const shutdown = new AbortController();
  const dispatched: string[] = [];
  let polls = 0;
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const method = new URL(input).pathname.split("/").at(-1)!;
    if (method === "getUpdates") {
      if (++polls === 2) { shutdown.abort(); return Response.json({ ok: true, result: [] }); }
      const message = { chat: { id: 42 }, from: { id: 99 }, message_id: 1 };
      return Response.json({ ok: true, result: [
        { update_id: 1, message: { ...message, text: `/blacklist add ${key(1)}` } },
        { update_id: 2, message: { ...message, chat: { id: 99 }, from: { id: 42 }, text: `/blacklist remove ${key(1)}` } },
        { update_id: 3, callback_query: { id: "denied", from: message.from, message, data: `cmd:/blacklist add ${key(1)}` } },
        { update_id: 4, message: { ...message, from: { id: 42 }, text: "/blacklist" } },
      ] });
    }
    assert.ok(["setMyCommands", "setChatMenuButton", "sendMessage"].includes(method));
    return Response.json({ ok: true, result: true });
  });
  await runBot({ token: "123:test", chatId: "42", signal: shutdown.signal,
    onCommand: async (command, args) => { dispatched.push(command); return handler.onCommand(command, args); },
    onCallback: async () => { throw new Error("Unauthorized callback reached handler"); },
  });
  assert.deepEqual(dispatched, ["/blacklist"]);
  assert.deepEqual(appConfig.top_careless.blacklisted_mints, []);
  assert.equal(db.prepare("SELECT count(*) n FROM config_changes").get()!.n, 0);
});

test("Careless marks unique active wallet positions by mint and pool without changing ranking", () => {
  const selected = selectTopCareless([makePool(), makePool(1, { pool_address: key(103) }), makePool(2)], config, now);
  const ranked = selected.map((pool) => pool.address);
  const first = activePosition(1);
  const ignored = { ...activePosition(2), ignored: true };
  const text = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Jakarta", new Date(now), {
    positions: [first, first, ignored, activePosition(3, key(104)), { ...activePosition(4), state: "CLOSED" }],
    syncedAt: now, discoveryFailed: false, pollIntervalSec: 300,
  });
  const cards = text.split("━━━━━━━━━━━━━━━━━━");
  const samePool = cards.find((part) => part.includes(`Pool <code>${key(101)}</code>`))!;
  assert.match(samePool, /👛 Token: <b>SUDAH ADA<\/b> · 3 posisi di 2 pool/);
  assert.match(samePool, /🏊 Pool ini: <b>AKTIF<\/b> · 2 posisi/);
  const otherPool = cards.find((part) => part.includes(`Pool <code>${key(103)}</code>`))!;
  assert.match(otherPool, /👛 Token: <b>SUDAH ADA/);
  assert.match(otherPool, /🏊 Pool ini: <b>BELUM ADA/);
  const sameSymbol = cards.find((part) => part.includes(`Pool <code>${key(102)}</code>`))!;
  assert.match(sameSymbol, /👛 Token: <b>BELUM ADA/);
  assert.match(sameSymbol, /🏊 Pool ini: <b>BELUM ADA/);
  assert.deepEqual(selected.map((pool) => pool.address), ranked);
  const offsets = ranked.map((address) => text.indexOf(`Pool <code>${address}</code>`));
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.match(text, /Sinkronisasi wallet:/); assert.doesNotMatch(text, /BELUM TERVERIFIKASI/);
  assert.equal((text.match(/Buka Meteora DLMM/g) ?? []).length, 3);
});

test("Careless recognizes both token sides and keeps the original formatter compatible without wallet context", () => {
  const selected = selectTopCareless([makePool()], config, now);
  const text = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Jakarta", new Date(now), {
    positions: [activePosition(1, key(101), sol, key(1)), activePosition(2, key(105), key(5), key(1))],
    syncedAt: now, discoveryFailed: false, pollIntervalSec: 300,
  });
  assert.match(text, /SUDAH ADA<\/b> · 2 posisi di 2 pool/);
  assert.match(text, /AKTIF<\/b> · 1 posisi/);
  const old = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Jakarta", new Date(now));
  assert.doesNotMatch(old, /👛 Token:|🏊 Pool ini:|Sinkronisasi wallet/);
});

test("Careless does not claim absence from stale, failed or unknown wallet snapshots", () => {
  const selected = selectTopCareless([makePool(), makePool(2)], config, now);
  for (const status of [
    { syncedAt: now - 600001, discoveryFailed: false },
    { syncedAt: now, discoveryFailed: true },
    { syncedAt: undefined, discoveryFailed: false },
    { syncedAt: NaN, discoveryFailed: false },
    { syncedAt: now + 1, discoveryFailed: false },
    { syncedAt: 0, discoveryFailed: false },
  ]) {
    const text = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Shanghai", new Date(now), {
      positions: [activePosition(1)], pollIntervalSec: 300, ...status,
    });
    assert.match(text, /SUDAH ADA<\/b> · 1 posisi di 1 pool · data terakhir/);
    assert.match(text, /AKTIF<\/b> · 1 posisi · data terakhir/);
    assert.match(text, /BELUM TERVERIFIKASI/);
    assert.doesNotMatch(text, /<b>BELUM ADA<\/b>|Invalid Date|NaN|WIB/);
  }
  for (const age of [0, 600000]) {
    const text = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Jakarta", new Date(now), {
      positions: [], syncedAt: now - age, discoveryFailed: false, pollIntervalSec: 300,
    });
    assert.match(text, /<b>BELUM ADA<\/b>/); assert.doesNotMatch(text, /BELUM TERVERIFIKASI/);
  }
  const custom = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Jakarta", new Date(now), {
    positions: [], syncedAt: now - 120001, discoveryFailed: false, pollIntervalSec: 60,
  });
  assert.match(custom, /BELUM TERVERIFIKASI/);
});

test("Careless uses real cached positions after screening, ignoring virtual and paper-closed states without RPC", async (t) => {
  t.mock.method(Date, "now", () => now);
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const appConfig = parseConfig(await readFile("config.example.json", "utf8"));
  new PaperAutomation({ db, config: appConfig, market: {} as any, pnl: {} as any, discover: async () => false,
    price: () => undefined, notify: async () => {} });
  const put = db.prepare(`INSERT INTO positions(id,pool,token_mint,quote_mint,lower_bin_id,upper_bin_id,first_seen_at,last_checked,state,ignored)
    VALUES(?,?,?,?,0,10,1,? ,?,1)`);
  put.run(key(151), key(101), key(1), sol, now, "OPEN");
  put.run(key(153), key(103), key(3), sol, now, "CLOSED");
  const paper = db.prepare(`INSERT INTO automation_positions(id,source_id,origin,pool,mint,lower_bin,upper_bin,bin_step,state,opened_at)
    VALUES(?,?,?,?,?,0,10,80,?,1)`);
  paper.run("closed-paper", key(151), "manual", key(101), key(1), "CLOSED");
  paper.run("virtual-paper", null, "virtual", key(102), key(2), "OPEN");
  t.mock.method(globalThis, "fetch", async () => {
    setMeta(db, "position_discovery_succeeded_at", String(now));
    return pageResponse([makePool(), makePool(2), makePool(3)]);
  });
  const handler = handlerFor(db, appConfig, "fake-api-key");
  const reply = await handler.onCommand("/topcareless", []);
  const cards = reply!.text.split("━━━━━━━━━━━━━━━━━━");
  assert.match(cards.find((part) => part.includes(`Pool <code>${key(101)}</code>`))!, /SUDAH ADA<\/b> · 1 posisi/);
  for (const pool of [key(102), key(103)]) {
    const card = cards.find((part) => part.includes(`Pool <code>${pool}</code>`))!;
    assert.match(card, /👛 Token: <b>BELUM ADA<\/b>/); assert.match(card, /🏊 Pool ini: <b>BELUM ADA<\/b>/);
  }
  setMeta(db, "position_discovery_succeeded_at", String(now - 600001));
  const connection = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({
    owner: (feed as any).program.programId, data: Buffer.alloc(0),
  })) };
  const feed = new ActiveBinMonitor({ db, connection: connection as any, fallbackPollMs: 15000 });
  t.after(() => feed.close());
  t.mock.method((feed as any).program.coder.accounts, "decode", () => ({ activeId: 5, binStep: 80, tokenXMint: new PublicKey(sol) }));
  await feed.poll();
  assert.equal(getMeta(db, "position_discovery_succeeded_at"), String(now - 600001));
  const stored = db.prepare("SELECT last_checked FROM positions WHERE id=?").get(key(151))!;
  assert.equal(stored.last_checked, now);
  // No additional metadata fetch resets the stale timestamp during this request.
  t.mock.method(globalThis, "fetch", async () => pageResponse([makePool(), makePool(2)]));
  const stale = await handler.onCallback("cmd:/topcareless");
  assert.match(stale!.text, /data terakhir/); assert.match(stale!.text, /BELUM TERVERIFIKASI/);
});

test("Careless retries rate limits using provider headers or bounded fallback delays", async (t) => {
  const cases = [
    { name: "missing headers", headers: {}, failures: 2, waits: [1000, 2000] },
    { name: "Retry-After seconds", headers: { "retry-after": "2" }, failures: 1, waits: [2000] },
    { name: "Retry-After date", headers: { "retry-after": new Date(now + 2000).toUTCString() }, failures: 1, waits: [2000] },
    { name: "Jupiter reset", headers: { "x-ratelimit-reset": String(now / 1000 + 3) }, failures: 1, waits: [3000] },
    { name: "later header wins", headers: { "retry-after": "1", "x-ratelimit-reset": String(now / 1000 + 3) }, failures: 1, waits: [3000] },
    { name: "malformed headers", headers: { "retry-after": "bad", "x-ratelimit-reset": "Infinity" }, failures: 1, waits: [1000] },
    { name: "expired headers", headers: { "retry-after": new Date(now - 2000).toUTCString(), "x-ratelimit-reset": "-1" }, failures: 1, waits: [1000] },
    { name: "zero wait", headers: { "retry-after": "0" }, failures: 1, waits: [0] },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    let clock = now, requests = 0;
    const waits: number[] = [];
    t.mock.method(Date, "now", () => clock);
    t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
      waits.push(delay); clock += delay; callback(); return 0 as any;
    });
    t.mock.method(globalThis, "fetch", async (input: string | URL) => {
      if (++requests <= scenario.failures) return Response.json({}, { status: 429, headers: scenario.headers });
      return pageResponse([makePool()]);
    });
    const result = await fetchTopCareless(config);
    assert.equal(result.pools.length, 1);
    assert.equal(requests, scenario.failures + 1);
    assert.deepEqual(waits, scenario.waits);
  });
});

test("Careless stops retries at the attempt or wait budget and gives Refresh guidance", async (t) => {
  const cases = [
    { name: "persistent 429", headers: {}, requests: 3, waits: [1000, 2000], hint: /beberapa saat lagi/ },
    { name: "long reset", headers: { "x-ratelimit-reset": String(now / 1000 + 60) }, requests: 1, waits: [], hint: /dalam 60 detik/ },
    { name: "total wait budget", headers: { "retry-after": "3" }, requests: 2, waits: [3000], hint: /dalam 3 detik/ },
    { name: "later header exceeds budget", headers: { "retry-after": "1", "x-ratelimit-reset": String(now / 1000 + 6) }, requests: 1, waits: [], hint: /dalam 6 detik/ },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    let clock = now, requests = 0;
    const waits: number[] = [];
    t.mock.method(Date, "now", () => clock);
    t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
      waits.push(delay); clock += delay; callback(); return 0 as any;
    });
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return Response.json({}, { status: 429, headers: scenario.headers });
    });
    await assert.rejects(fetchTopCareless(config), (error) => {
      assert.match(String(error), /HTTP 429.*Coba Refresh/);
      assert.match(String(error), scenario.hint);
      assert.doesNotMatch(String(error), /fake-api-key/);
      return true;
    });
    assert.equal(requests, scenario.requests);
    assert.deepEqual(waits, scenario.waits);
  });
});

test("Careless config defaults old files, validates filters and persists Telegram changes without restart", async () => {
  const raw = JSON.parse(await readFile("config.example.json", "utf8"));
  delete raw.top_careless;
  raw.top_trending = { enabled: true };
  const appConfig = parseConfig(JSON.stringify(raw));
  assert.deepEqual(appConfig.top_careless, config);
  for (const [path, value] of [["limit", 0], ["limit", 101], ["limit", 1.5], ["min_tvl_usd", -1], ["min_token_age_days", null], ["enabled", "true"]]) {
    assert.throws(() => prepareConfigUpdate(appConfig, `top_careless.${path}`, JSON.stringify(value)));
  }
  const directory = await mkdtemp(join(tmpdir(), "yolow-careless-"));
  const db = openDatabase(":memory:");
  const path = join(directory, "config.json");
  try {
    const handler = handlerFor(db, appConfig, "fake-api-key", path);
    const section = await handler.onCallback("config:section:careless");
    assert.match(section?.text ?? "", /top_careless.min_tvl_usd = 5000/);
    for (const [field, value] of [["enabled", false], ["limit", 20], ["min_market_cap_usd", 2_000_000], ["min_token_age_days", 5], ["min_tvl_usd", 7500]] as const) {
      const reply = await handler.onCommand("/config", ["set", `top_careless.${field}`, JSON.stringify(value)]);
      assert.match(reply?.text ?? "", /CONFIG DISIMPAN/);
      assert.match(reply?.text ?? "", /aktif sekarang/);
      assert.equal(appConfig.top_careless[field], value);
    }
    assert.deepEqual(parseConfig(await readFile(path, "utf8")).top_careless, appConfig.top_careless);
    appConfig.swap.enabled = false;
    const noKey = handlerFor(db, appConfig, undefined, path);
    const enabled = await noKey.onCommand("/config", ["set", "top_careless.enabled", "true"]);
    assert.match(enabled?.text ?? "", /CONFIG DISIMPAN/);
    assert.equal(appConfig.top_careless.enabled, true);
    const allowed = await noKey.onCommand("/config", ["set", "top_careless.limit", "25"]);
    assert.match(allowed?.text ?? "", /CONFIG DISIMPAN/);
    assert.equal(appConfig.top_careless.limit, 25);
    const swapRejected = await noKey.onCommand("/config", ["set", "swap.enabled", "true"]);
    assert.match(swapRejected?.text ?? "", /JUPITER_API_KEY/);
    assert.equal(appConfig.swap.enabled, false);
    appConfig.top_careless.enabled = false;
    assert.match((await noKey.onCommand("/topcareless", []))?.text ?? "", /dinonaktifkan/);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const count of [0, 1, 10]) {
  test(`Careless keyboard button and callback render ${count} pools safely, keep filters and enforce authorization`, async (t) => {
    t.mock.method(Date, "now", () => now);
    t.mock.method(console, "log", () => {});
    const appConfig = parseConfig(await readFile("config.example.json", "utf8"));
    const db = openDatabase(":memory:"); t.after(() => db.close());
    setMeta(db, "position_discovery_succeeded_at", String(now));
    db.prepare(`INSERT INTO positions(id,pool,token_mint,quote_mint,lower_bin_id,upper_bin_id,first_seen_at,last_checked,ignored)
      VALUES(?,?,?,?,0,10,1,1,1)`).run(key(151), key(101), key(1), sol);
    const handler = handlerFor(db, appConfig, "fake-api-key");
    const shutdown = new AbortController();
    let polls = 0, poolRequests = 0;
    const replies: Array<{ method: string; body: any }> = [];
    const message = { chat: { id: 42 }, from: { id: 42 }, message_id: 10 };
    t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname === "pool-discovery-api.datapi.meteora.ag") {
        poolRequests++;
        return pageResponse(Array.from({ length: count }, (_, i) => makePool(i + 1, { token_x: { ...makePool(i + 1).token_x, symbol: "<".repeat(16), name: "&".repeat(32) } })));
      }
      const method = url.pathname.split("/").at(-1)!;
      if (method === "getUpdates") {
        if (++polls === 2) { shutdown.abort(); return Response.json({ ok: true, result: [] }); }
        return Response.json({ ok: true, result: [
          { update_id: 1, message: { ...message, text: "🧪 Top Careless" } },
          { update_id: 2, callback_query: { id: "refresh", from: message.from, message, data: "cmd:/topcareless" } },
          { update_id: 3, callback_query: { id: "filter", from: message.from, message, data: "config:section:careless" } },
          { update_id: 4, message: { ...message, from: { id: 99 }, text: "/topcareless" } },
        ] });
      }
      const body = JSON.parse(String(init?.body));
      if (["sendMessage", "editMessageText"].includes(method)) replies.push({ method, body });
      return Response.json({ ok: true, result: true });
    });
    await runBot({ token: "123:test", chatId: "42", signal: shutdown.signal,
      onCommand: handler.onCommand, onCallback: handler.onCallback });
    assert.equal(poolRequests, 2);
    const rendered = replies.filter(reply => reply.body.parse_mode === "HTML");
    const text = rendered.map(reply => reply.body.text).join("\n");
    assert.equal((text.match(/Buka Meteora DLMM/g) ?? []).length, count * 2);
    assert.equal((text.match(/Fee\/Active TVL 24j <b>4\.00%<\/b>/g) ?? []).length, count * 2);
    assert.equal((text.match(/Base fee 0\.10% · Bin step/g) ?? []).length, count * 2);
    assert.equal((text.match(/👛 Token: <b>/g) ?? []).length, count * 2);
    assert.equal((text.match(/🏊 Pool ini: <b>AKTIF<\/b>/g) ?? []).length, count > 0 ? 2 : 0);
    assert.doesNotMatch(text, /BELUM TERVERIFIKASI/);

    for (const { body } of rendered) {
      assert.deepEqual(body.link_preview_options, { is_disabled: true });
      assert.ok(body.text.length <= 3500);
      assert.doesNotMatch(body.text, /<<<<|&&&&/);
      assert.match(body.text, /&lt;|&amp;|Active TVL/);
      for (const tag of ["b", "i", "code", "a"]) {
        assert.equal((body.text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g")) ?? []).length,
          (body.text.match(new RegExp(`</${tag}>`, "g")) ?? []).length, `unbalanced ${tag} in message chunk`);
      }
    }
    assert.ok(rendered[0].body.reply_markup.inline_keyboard.flat().some((button: any) => button.callback_data === "config:section:careless"));
    assert.match(replies.at(-1)!.body.text, /top_careless.min_tvl_usd = 5000/);
    if (count <= 1) assert.ok(rendered.some(reply => reply.method === "editMessageText"));
    else assert.ok(rendered.length > 2);
  });
}

test("Careless applies all eight web filters inclusively and uses the active-TVL ratio", () => {
  assert.equal(selectTopCareless([makePool()], config, now).length, 1);
  const base = makePool();
  const rejected = [
    { pool_type: "damm_v2" }, { pool_type: undefined },
    { token_x: { ...base.token_x, market_cap: 999999.99 } },
    { token_x: { ...base.token_x, created_at: now - 72 * 3600000 + 1 } },
    { token_x: { ...base.token_x, created_at: now + 1 } },
    { token_x: { ...base.token_x, created_at: undefined } },
    { token_x: { ...base.token_x, organic_score: 49.999 } },
    { token_y: { ...base.token_y, organic_score: 49.999 } },
    { base_token_holders: 999 }, { base_token_holders: 1000.5 },
    { tvl: 4999.99 }, { fee_active_tvl_ratio: 3.99999 },
    { dlmm_params: { bin_step: 79 } }, { dlmm_params: {} },
    { token_y: { ...base.token_y, address: key(99) } }, { pool_address: "invalid" },
    { active_tvl: 0 }, { token_x: { ...base.token_x, organic_score: 101 } },
  ];
  for (const overrides of rejected) assert.equal(selectTopCareless([makePool(1, overrides)], config, now).length, 0, JSON.stringify(overrides));
  const [pool] = selectTopCareless([makePool(1, { volume: 0, fee_pct: 0, fee_active_tvl_ratio: 4 })], config, now);
  assert.equal(pool.feeActiveTvl24hPercent, 4);
  assert.equal(pool.ageDays * 24, 72);
  for (const field of ["tvl", "active_tvl", "volume", "fee_pct", "fee_active_tvl_ratio"]) {
    for (const value of [undefined, null, true, NaN, -1, "", "bad", Infinity]) {
      assert.equal(selectTopCareless([makePool(1, { [field]: value })], config, now).length, 0);
    }
  }
  assert.equal(selectTopCareless([makePool(1, { fee_pct: 101 })], config, now).length, 0);
});

test("Careless handles both SOL orientations and blacklist/exclusions before limiting", async (t) => {
  const pool = makePool();
  const flipped = makePool(1, { pool_address: key(110), token_x: pool.token_y, token_y: pool.token_x });
  const cfg = { ...config, limit: 1, blacklisted_mints: [key(1)] };
  const data = [pool, flipped, makePool(2), makePool(3, { fee_active_tvl_ratio: 5 })];
  assert.equal(selectTopCareless([flipped], config, now)[0].mint, key(1));
  assert.deepEqual(selectTopCareless(data, cfg, now).map(x => x.mint), [key(3)]);
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: any) => {
    calls++; assert.equal(new URL(input).hostname, "pool-discovery-api.datapi.meteora.ag");
    return pageResponse(data);
  });
  const result = await fetchTopCareless(cfg, { excludedMints: new Set([key(3)]) });
  assert.deepEqual(result.pools.map(x => x.mint), [key(2)]);
  assert.equal(calls, 1);
  assert.deepEqual((await fetchTopCareless(config, { minBinStep: 100 })).pools, []);
});

test("Careless ranks Fee/Active TVL then volume and address, preserving separate pools", () => {
  const pools = [makePool(), makePool(1, { pool_address: key(103), fee_active_tvl_ratio: 5 }),
    makePool(1, { pool_address: key(104), volume: 100000 })];
  const selected = selectTopCareless([...pools, pools[0]], config, now);
  assert.deepEqual(selected.map(x => x.address), [key(103), key(104), key(101)]);
  const tied = selectTopCareless([makePool(1, { pool_address: key(103) }), makePool()], config, now);
  assert.deepEqual(tied.map(x => x.address), [key(103), key(101)].sort((a,b) => a.localeCompare(b)));
  const text = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Jakarta", new Date(now));
  for (const pattern of [/Fee\/Active TVL 24j <b>5\.00%/, /Organic Score ≥ 50/, /Holders ≥ 1000/, /Umur ≥ 72 jam/, /Bin step ≥ 80/, /Active TVL/, /bukan jaminan/]) assert.match(text, pattern);
  assert.doesNotMatch(text, /Simple Fee|APR|firstPool Jupiter/);
  const hostile = { ...selected[0], symbol: "<b>&", name: "</a><script>bad</script>" };
  assert.doesNotMatch(formatTopCareless({ pools: [hostile], limited: false }, config, "UTC"), /<script>/);
});

test("Discovery uses the exact web endpoint, 24h window, numeric percentages and cursor pagination", async (t) => {
  t.mock.method(Date, "now", () => now);
  const urls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const u = new URL(input); urls.push(u);
    assert.equal(init.redirect, "error"); assert.ok(init.signal);
    assert.equal(u.origin, "https://pool-discovery-api.datapi.meteora.ag");
    assert.equal(u.searchParams.get("timeframe"), "24h");
    assert.equal(u.searchParams.get("category"), "all");
    assert.equal(u.searchParams.get("sort_by"), "fee_active_tvl_ratio:desc,volume:desc");
    assert.equal(u.searchParams.get("page_size"), "100");
    const filter = u.searchParams.get("filter_by")!;
    for (const term of ["pool_type=dlmm", "tvl>=5000", "fee_active_tvl_ratio>=4", "base_token_market_cap>=1000000", "base_token_holders>=1000", "base_token_organic_score>=50", "quote_token_organic_score>=50", "dlmm_bin_step>=80", `base_token_created_at<=${now - 72 * 3600000}`]) assert.ok(filter.split("&&").includes(term), term);
    if (urls.length === 1) {
      assert.equal(u.searchParams.get("after_key"), null);
      return pageResponse([makePool()], true, "cursor-1");
    }
    assert.equal(u.searchParams.get("after_key"), "cursor-1");
    return pageResponse([makePool(2, { fee_active_tvl_ratio: 8 })]);
  });
  const result = await fetchTopCareless({ ...config, limit: 1 });
  assert.equal(urls.length, 2); assert.equal(result.limited, false);
  assert.equal(result.pools[0].address, key(102));
});

test("Discovery caps 20 pages, rejects invalid cursors/schemas and never returns partial results", async (t) => {
  t.mock.method(Date, "now", () => now);
  let calls = 0, complete = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return pageResponse([makePool()], !(complete && calls % 20 === 0), `cursor-${calls}`);
  });
  assert.equal((await fetchTopCareless(config)).limited, true); assert.equal(calls, 20);
  complete = true;
  assert.equal((await fetchTopCareless(config)).limited, false); assert.equal(calls, 40);
  for (const body of [null, { data: [], has_more: true, after_key: "c" }, { data: [null], has_more: false },
    { data: {}, has_more: false }, { data: [], has_more: 1 }, { data: [], has_more: false, after_key: null },
    { data: [makePool()], has_more: true }, { data: [makePool()], has_more: true, after_key: "x".repeat(8193) }]) {
    if (body?.has_more === false && Array.isArray(body.data) && body.data.length === 0) continue;
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(fetchTopCareless(config), /tidak sesuai format/);
  }
  t.mock.method(globalThis, "fetch", async () => pageResponse([makePool()], true, "repeated"));
  await assert.rejects(fetchTopCareless(config), /tidak sesuai format/);
  for (const code of [400, 401, 403, 500]) {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: code }));
    await assert.rejects(fetchTopCareless(config), new RegExp(`HTTP ${code}`));
  }
  t.mock.method(globalThis, "fetch", async () => new Response("not-json"));
  await assert.rejects(fetchTopCareless(config), /JSON yang tidak valid/);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret must not leak"); });
  await assert.rejects(fetchTopCareless(config), /gagal diakses/);
});

test("Discovery failures on later pages produce a safe Telegram error, not partial ranking", async (t) => {
  t.mock.method(Date, "now", () => now);
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const appConfig = parseConfig(await readFile("config.example.json", "utf8"));
  let calls = 0;
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? pageResponse([makePool()], true, "next") : new Response("secret", { status: 500 }));
  const reply = await handlerFor(db, appConfig).onCommand("/topcareless", []);
  assert.match(reply!.text, /Screening gagal:.*HTTP 500/);
  assert.doesNotMatch(reply!.text, /Buka Meteora|secret/);
});

test("new Careless config fields default older files, validate and hot-apply", async () => {
  const raw = JSON.parse(await readFile("config.example.json", "utf8"));
  const fields = ["min_organic_score", "min_holders", "min_fee_active_tvl_24h_percent", "min_bin_step"];
  for (const field of fields) delete raw.top_careless[field];
  const cfg = parseConfig(JSON.stringify(raw));
  for (const field of fields) assert.equal((cfg.top_careless as any)[field], (config as any)[field]);
  for (const [field, value] of [["min_organic_score", 101], ["min_organic_score", -1], ["min_holders", 1.5], ["min_holders", Number.MAX_SAFE_INTEGER+1], ["min_fee_active_tvl_24h_percent", -1], ["min_bin_step", 0], ["min_bin_step", 80.5], ...fields.map(field => [field, null])]) {
    assert.throws(() => prepareConfigUpdate(cfg, `top_careless.${field}`, JSON.stringify(value)));
  }
  for (const [field, value] of [["min_organic_score", 60], ["min_holders", 2000], ["min_fee_active_tvl_24h_percent", 5], ["min_bin_step", 100]]) {
    const update = prepareConfigUpdate(cfg, `top_careless.${field}`, String(value));
    assert.equal(update.restartRequired, false);
    assert.equal((update.config.top_careless as any)[field], value);
  }
});

test("sanitized Meteora web discovery fixture retains provider ratio, score, holders and bin step", async () => {
  const pool = JSON.parse(await readFile("test/fixtures/meteora-discovery.json", "utf8"));
  const selected = selectTopCareless([pool], config, Date.UTC(2026, 10, 2, 12));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].feeActiveTvl24hPercent, pool.fee_active_tvl_ratio);
  assert.equal(selected[0].activeTvlUsd, pool.active_tvl);
  assert.equal(selected[0].organicScore, pool.token_x.organic_score);
  assert.equal(selected[0].holders, pool.base_token_holders);
  assert.equal(selected[0].binStep, pool.dlmm_params.bin_step);
});
