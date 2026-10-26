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
const config: TopCarelessConfig = { enabled: true, limit: 10, min_market_cap_usd: 1_500_000, min_token_age_days: 3, min_tvl_usd: 5000, blacklisted_mints: [] };
const makePool = (n = 1, overrides = {}) => ({
  address: key(n + 100), token_x: { address: key(n), market_cap: 1_500_000, symbol: "TOKEN", name: "Token" },
  token_y: { address: sol }, tvl: 5000, volume: { "24h": 50_000 }, fee_tvl_ratio: { "24h": 0.1 }, pool_config: { bin_step: 25, base_fee_pct: 0.1 }, ...overrides,
});
const makeToken = (n = 1, ageDays = 3) => ({ id: key(n), firstPool: { createdAt: new Date(now - ageDays * 86_400_000).toISOString() } });
const poolsUrl = "https://dlmm.datapi.meteora.ag";
const tokensUrl = "https://api.jup.ag/tokens/v2";

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

test("manual blacklist removes every matching pool in both SOL orientations before ranking and metadata", async (t) => {
  t.mock.method(Date, "now", () => now);
  const cfg = { ...config, limit: 2, blacklisted_mints: [key(1)] };
  const pools = [makePool(), makePool(1, { address: key(110), token_x: { address: sol }, token_y: makePool().token_x }),
    makePool(2), makePool(3, { volume: { "24h": 100000 } })];
  const tokens = [makeToken(1), makeToken(2), makeToken(3)];
  const selected = selectTopCareless(pools, new Map(tokens.map((token) => [token.id, token])), cfg, now);
  assert.deepEqual(selected.map((item) => item.mint), [key(3), key(2)]);
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    if (url.hostname === "dlmm.datapi.meteora.ag") return Response.json({ pages: 1, data: pools });
    assert.equal(url.hostname, "api.jup.ag");
    queries.push(url.searchParams.get("query")!);
    return Response.json(tokens.slice(1));
  });
  const result = await fetchTopCareless(cfg, "test", poolsUrl, tokensUrl);
  assert.deepEqual(result.pools, selected);
  assert.deepEqual(queries, [[key(2), key(3)].join(",")]);
  cfg.blacklisted_mints.push(key(2), key(3));
  assert.deepEqual((await fetchTopCareless(cfg, "test", poolsUrl, tokensUrl)).pools, []);
  assert.equal(queries.length, 1);
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
  const selected = selectTopCareless([makePool(), makePool(1, { address: key(103) }), makePool(2)],
    new Map([[key(1), makeToken()], [key(2), makeToken(2)]]), config, now);
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
  const selected = selectTopCareless([makePool()], new Map([[key(1), makeToken()]]), config, now);
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
  const selected = selectTopCareless([makePool(), makePool(2)], new Map([[key(1), makeToken()], [key(2), makeToken(2)]]), config, now);
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
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    if (url.hostname === "dlmm.datapi.meteora.ag") return Response.json({ pages: 1, data: [makePool(), makePool(2), makePool(3)] });
    assert.equal(url.hostname, "api.jup.ag");
    setMeta(db, "position_discovery_succeeded_at", String(now));
    return Response.json([makeToken(), makeToken(2), makeToken(3)]);
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
  const feed = new ActiveBinMonitor({ db, connection: {} as any, fallbackPollMs: 15000 });
  await (feed as any).updateStoredBins(key(101), 5);
  assert.equal(getMeta(db, "position_discovery_succeeded_at"), String(now - 600001));
  const stored = db.prepare("SELECT last_checked FROM positions WHERE id=?").get(key(151))!;
  assert.equal(stored.last_checked, now);
  // No additional metadata fetch resets the stale timestamp during this request.
  t.mock.method(globalThis, "fetch", async (input: string | URL) => new URL(input).hostname === "dlmm.datapi.meteora.ag"
    ? Response.json({ pages: 1, data: [makePool(), makePool(2)] }) : Response.json([makeToken(), makeToken(2)]));
  const stale = await handler.onCallback("cmd:/topcareless");
  assert.match(stale!.text, /data terakhir/); assert.match(stale!.text, /BELUM TERVERIFIKASI/);
});

test("Careless requires inclusive market cap, token age and TVL thresholds and exact SOL pairs", () => {
  const token = makeToken();
  const metadata = new Map([[key(1), token]]);
  assert.equal(selectTopCareless([makePool()], metadata, config, now).length, 1);
  assert.equal(selectTopCareless([makePool(1, { token_x: { ...makePool().token_x, market_cap: 1_499_999 } })], metadata, config, now).length, 0);
  assert.equal(selectTopCareless([makePool(1, { tvl: 4999.99 })], metadata, config, now).length, 0);
  assert.equal(selectTopCareless([makePool()], new Map([[key(1), makeToken(1, 2.9999)]]), config, now).length, 0);
  assert.equal(selectTopCareless([makePool()], new Map([[key(1), makeToken(1, 365)]]), config, now).length, 1);
  assert.equal(selectTopCareless([makePool(1, { token_x: { address: sol }, token_y: makePool().token_x })], metadata, config, now).length, 1);
  assert.equal(selectTopCareless([makePool(1, { token_y: { address: key(2), symbol: "SOL" } })], metadata, config, now).length, 0);
  assert.equal(selectTopCareless([makePool()], new Map(), config, now).length, 0);
  assert.equal(selectTopCareless([makePool(1, { address: "bad-link" })], metadata, config, now).length, 0);
  assert.equal(selectTopCareless([makePool(1, { volume: {} })], metadata, config, now).length, 0);
});

test("Careless calculates simple fee percentages and validates ranking inputs without requiring APR", () => {
  const metadata = new Map([[key(1), makeToken()]]);
  const [pool] = selectTopCareless([makePool(1, { tvl: "10000", volume: { "24h": "100000" }, pool_config: { base_fee_pct: "0.3" } })], metadata, config, now);
  assert.equal(pool.baseFeePercent, 0.3);
  assert.equal(pool.simpleFeeTvl24hPercent, 3);
  const text = formatTopCareless({ pools: [pool], limited: false }, config, "Asia/Jakarta");
  assert.match(text, /Simple Fee\/TVL 24j <b>3\.00%<\/b>/);
  assert.match(text, /Base fee 0\.30% · Bin step/);
  for (const value of [undefined, null, true, NaN, -1, "", " ", "bad", Infinity]) {
    assert.equal(selectTopCareless([makePool(1, { pool_config: { base_fee_pct: value } })], metadata, config, now).length, 0);
    assert.equal(selectTopCareless([makePool(1, { volume: { "24h": value } })], metadata, config, now).length, 0);
    assert.equal(selectTopCareless([makePool(1, { tvl: value })], metadata, config, now).length, 0);
  }
  assert.equal(selectTopCareless([makePool(1, { pool_config: {} })], metadata, config, now).length, 0);
  assert.equal(selectTopCareless([makePool(1, { pool_config: { base_fee_pct: 101 } })], metadata, config, now).length, 0);
  assert.equal(selectTopCareless([makePool(1, { tvl: 0 })], metadata, { ...config, min_tvl_usd: 0 }, now).length, 0);
  assert.equal(selectTopCareless([makePool(1, { tvl: 1e-300, volume: { "24h": 1e308 } })], metadata, { ...config, min_tvl_usd: 0 }, now).length, 0);
  for (const overrides of [{ volume: { "24h": 0 } }, { pool_config: { base_fee_pct: 0 } }]) {
    assert.equal(selectTopCareless([makePool(1, overrides)], metadata, config, now)[0].simpleFeeTvl24hPercent, 0);
  }
  for (const ratio of [undefined, NaN, -1, "", " ", "bad", Infinity]) {
    const [withoutApr] = selectTopCareless([makePool(1, { fee_tvl_ratio: { "24h": ratio } })], metadata, config, now);
    assert.equal(withoutApr.simpleFeeTvl24hPercent, 1);
    assert.equal(withoutApr.feeTvl24hPercent, undefined);
    assert.equal(withoutApr.aprPercent, undefined);
    const text = formatTopCareless({ pools: [withoutApr], limited: false }, config, "Asia/Jakarta");
    assert.match(text, /APR estimasi <b>Belum tersedia<\/b>/);
    assert.match(text, /Fee\/TVL 24j Belum tersedia/);
    assert.doesNotMatch(text, /NaN|Infinity|undefined|Belum tersedia%/);
  }
  const [overflowApr] = selectTopCareless([makePool(1, { fee_tvl_ratio: { "24h": 1e308 } })], metadata, config, now);
  assert.equal(overflowApr.aprPercent, undefined);
  const [zeroApr] = selectTopCareless([makePool(1, { fee_tvl_ratio: { "24h": 0 } })], metadata, config, now);
  assert.equal(zeroApr.aprPercent, 0);
});

test("Careless keeps each pool, ranks simple fee before APR, and annualizes comparison APR once", () => {
  const pools = [makePool(), makePool(1, { address: key(103), volume: { "24h": 100_000 } }),
    makePool(1, { address: key(104), fee_tvl_ratio: { "24h": "0.2" }, volume: { "24h": 1 } })];
  const selected = selectTopCareless([...pools, pools[0]], new Map([[key(1), makeToken()]]), config, now);
  assert.deepEqual(selected.map(pool => pool.address), [key(103), key(101), key(104)]);
  assert.equal(selected[0].simpleFeeTvl24hPercent, 2);
  assert.equal(selected[1].simpleFeeTvl24hPercent, 1);
  assert.equal(selected[1].feeTvl24hPercent, 0.1);
  assert.equal(selected[1].aprPercent, 36.5);
  const text = formatTopCareless({ pools: selected, limited: false }, config, "Asia/Jakarta", new Date(now));
  assert.match(text, /36\.50%/);
  assert.match(text, /Fee\/TVL 24j 0\.10%/);
  assert.match(text, /Urut Simple Fee\/TVL 24j/);
  assert.match(text, /Simple Fee\/TVL 24j <b>&lt;0\.01%<\/b>/);
  assert.match(text, /Bin step <b>25<\/b>/);
  assert.ok(text.includes(`CA <code>${key(1)}</code>`));
  assert.ok(text.includes(`https://app.meteora.ag/dlmm/${key(104)}`));
  assert.match(text, /tanpa farm reward/);
  const hostile = { ...selected[0], symbol: "<b>&", name: "</a><script>bad</script>", binStep: undefined };
  const escaped = formatTopCareless({ pools: [hostile], limited: true }, config, "Asia/Jakarta");
  assert.match(escaped, /&lt;b&gt;&amp;/);
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /Bin step <b>Belum tersedia/);
  assert.match(escaped, /Cakupan terbatas/);
  assert.match(formatTopCareless({ pools: [], limited: false }, config, "Asia/Jakarta"), /Belum ada pool/);
});

test("Careless breaks equal simple fee scores by volume then pool address before limiting", () => {
  const pools = [makePool(1, { address: key(103) }), makePool(1, { address: key(104), tvl: 10_000, volume: { "24h": 100_000 } }), makePool()];
  const selected = selectTopCareless(pools, new Map([[key(1), makeToken()]]), { ...config, limit: 2 }, now);
  assert.deepEqual(selected.map(pool => pool.address), [key(104), ...[key(101), key(103)].sort((a, b) => a.localeCompare(b)).slice(0, 1)]);
});

test("Careless cards highlight ranked scores, group pool data, and show the update timezone", () => {
  const pools = selectTopCareless(Array.from({ length: 4 }, (_, i) => makePool(i + 1)),
    new Map(Array.from({ length: 4 }, (_, i) => [key(i + 1), makeToken(i + 1)])), config, now);
  const text = formatTopCareless({ pools, limited: false }, config, "Asia/Jakarta", new Date(now));
  assert.match(text, /📋 <b>4\/10 pool<\/b> · Meteora DLMM · Pasangan SOL/);
  assert.match(text, /🔎 <b>Filter aktif<\/b>/);
  assert.match(text, /Diperbarui .*07\.00.*WIB/);
  for (const [index, marker] of ["🥇", "🥈", "🥉", "▫️"].entries()) {
    assert.ok(text.includes(`${marker} <b>${index + 1}. TOKEN/SOL</b>\n<i>Token</i>`));
  }
  assert.ok(text.indexOf("💎 Simple Fee/TVL") < text.indexOf("💧 TVL"));
  assert.match(text, /💧 TVL <b>\$5\.0K<\/b> · 📊 Volume 24j <b>\$50\.0K<\/b>/);
  assert.match(text, /ℹ️ <b>Cara baca<\/b>/);
  const empty = formatTopCareless({ pools: [], limited: false }, config, "Asia/Jakarta");
  assert.match(empty, /Ubah Filter atau coba Refresh/);
});

test("Careless scans later pages after filling results and queries token age once per mint", async (t) => {
  t.mock.method(Date, "now", () => now);
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input); calls.push(url);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (url.hostname === "api.jup.ag") {
      assert.equal(new Headers(init?.headers).get("x-api-key"), "fake-api-key");
      assert.equal(url.searchParams.get("query"), key(1));
      return Response.json([makeToken()]);
    }
    assert.equal(url.searchParams.get("sort_by"), "fee_tvl_ratio_24h:desc,volume_24h:desc");
    assert.equal(url.searchParams.get("filter_by"), "tvl>=5000");
    assert.equal(url.searchParams.get("page_size"), "100");
    const page = Number(url.searchParams.get("page"));
    return Response.json({ pages: 3, data: [makePool(1, { address: key(100 + page), volume: { "24h": page * 50_000 }, fee_tvl_ratio: { "24h": 0.4 - page * 0.1 } })] });
  });
  const result = await fetchTopCareless({ ...config, limit: 2 }, "fake-api-key", poolsUrl, tokensUrl);
  assert.equal(result.pools.length, 2);
  assert.equal(result.limited, false);
  assert.deepEqual(result.pools.map(pool => pool.address), [key(103), key(102)]);
  assert.equal(calls.filter(url => url.hostname === "api.jup.ag").length, 1);
  assert.equal(calls.filter(url => url.hostname !== "api.jup.ag").length, 3);
});

test("Careless batches unique mints across all pages before selecting the best pools", async (t) => {
  t.mock.method(Date, "now", () => now);
  const pools = Array.from({ length: 120 }, (_, i) => makePool(i + 1, { volume: { "24h": (i + 1) * 50_000 } }));
  const batches: string[][] = [];
  let poolRequests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    if (url.hostname === "dlmm.datapi.meteora.ag") {
      poolRequests++;
      const page = Number(url.searchParams.get("page"));
      return Response.json({ pages: 2, data: [...pools.slice((page - 1) * 60, page * 60), pools[0]] });
    }
    assert.equal(poolRequests, 2);
    const batch = url.searchParams.get("query")!.split(",");
    batches.push(batch);
    return Response.json(batch.map((id) => ({ ...makeToken(), id })));
  });
  const result = await fetchTopCareless({ ...config, limit: 2 }, "fake-api-key", poolsUrl, tokensUrl);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 20]);
  assert.equal(new Set(batches.flat()).size, 120);
  assert.deepEqual(result.pools.map((pool) => pool.address), [pools[119].address, pools[118].address]);
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
      if (new URL(input).hostname === "dlmm.datapi.meteora.ag") return Response.json({ pages: 1, data: [makePool()] });
      if (++requests <= scenario.failures) return Response.json({}, { status: 429, headers: scenario.headers });
      return Response.json([makeToken()]);
    });
    const result = await fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl);
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
    await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), (error) => {
      assert.match(String(error), /HTTP 429.*Coba Refresh/);
      assert.match(String(error), scenario.hint);
      assert.doesNotMatch(String(error), /fake-api-key/);
      return true;
    });
    assert.equal(requests, scenario.requests);
    assert.deepEqual(waits, scenario.waits);
  });
});

test("Careless reports capped coverage even when results are full and completes exactly 20 pages", async (t) => {
  t.mock.method(Date, "now", () => now);
  let pages = 21, poolRequests = 0, tokenRequests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    if (url.hostname === "api.jup.ag") {
      tokenRequests++;
      return Response.json([makeToken()]);
    }
    poolRequests++;
    const page = Number(url.searchParams.get("page"));
    return Response.json({ pages, data: [makePool(1, { address: key(100 + page), volume: { "24h": page * 50_000 } })] });
  });
  const result = await fetchTopCareless({ ...config, limit: 1 }, "fake-api-key", poolsUrl, tokensUrl);
  assert.equal(poolRequests, 20);
  assert.equal(tokenRequests, 1);
  assert.equal(result.pools.length, 1);
  assert.equal(result.pools[0].address, key(120));
  assert.equal(result.limited, true);
  assert.match(formatTopCareless(result, { ...config, limit: 1 }, "Asia/Jakarta"), /ranking hanya dari pool yang diperiksa/);
  pages = 20;
  const complete = await fetchTopCareless({ ...config, limit: 1 }, "fake-api-key", poolsUrl, tokensUrl);
  assert.equal(poolRequests, 40);
  assert.equal(complete.limited, false);
});

test("Careless bounds scanning and rejects malformed, timed out and non-rate-limit errors without retry", async (t) => {
  let calls = 0;
  let response: any = { pages: 21, data: [makePool(1, { tvl: 0 })] };
  let status = 200;
  let fails = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (fails) throw new Error("fake-api-key must not leak");
    return Response.json(response, { status });
  });
  const result = await fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl);
  assert.equal(calls, 20);
  assert.equal(result.limited, true);
  for (const body of [null, { data: [], pages: -1 }, { data: [null], pages: 1 }, { data: {}, pages: 1 }, { data: [], pages: 1.1 }]) {
    response = body;
    await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), /tidak sesuai format/);
  }
  for (const code of [400, 401, 403, 500]) {
    status = code;
    const previousCalls = calls;
    await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), new RegExp(`HTTP ${code}`));
    assert.equal(calls, previousCalls + 1);
  }
  fails = true;
  await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), error => {
    assert.doesNotMatch(String(error), /fake-api-key/); return true;
  });
});

test("Careless logs a safe error and returns no partial ranking when a later metadata batch fails", async (t) => {
  const appConfig = parseConfig(await readFile("config.example.json", "utf8"));
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const warning = t.mock.method(console, "warn", () => {});
  const pools = Array.from({ length: 120 }, (_, i) => makePool(i + 1));
  let metadataRequests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    if (url.hostname === "dlmm.datapi.meteora.ag") {
      const page = Number(url.searchParams.get("page"));
      return Response.json({ pages: 2, data: pools.slice((page - 1) * 60, page * 60) });
    }
    if (++metadataRequests === 2) return Response.json({ message: "fake-api-key must not leak" }, { status: 401 });
    return Response.json(url.searchParams.get("query")!.split(",").map((id) => ({ ...makeToken(), id })));
  });
  const reply = await handlerFor(db, appConfig, "fake-api-key").onCommand("/topcareless", []);
  assert.match(reply?.text ?? "", /Screening gagal:.*api.jup.ag.*HTTP 401/);
  assert.doesNotMatch(reply?.text ?? "", /fake-api-key|Buka Meteora|Belum ada pool/);
  assert.equal(reply?.parseMode, undefined);
  assert.deepEqual(reply?.replyMarkup?.inline_keyboard[0].map((button: any) => button.callback_data),
    ["cmd:/topcareless", "config:section:careless"]);
  assert.equal(metadataRequests, 2);
  assert.equal(warning.mock.callCount(), 1);
  const logged = warning.mock.calls[0].arguments.join(" ");
  assert.match(logged, /Top Careless screening failed:.*HTTP 401/);
  assert.doesNotMatch(logged, /fake-api-key/);
});

test("Careless rejects invalid metadata JSON and shapes without retry or empty results", async (t) => {
  let requests = 0;
  let invalidJson = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    if (new URL(input).hostname === "dlmm.datapi.meteora.ag") return Response.json({ pages: 1, data: [makePool()] });
    requests++;
    return invalidJson ? new Response("{broken") : Response.json({ message: "not an array" });
  });
  await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), /Respons token Jupiter tidak sesuai format/);
  invalidJson = true;
  await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), /JSON yang tidak valid/);
  assert.equal(requests, 2);
});

test("Careless config defaults old files, validates filters and persists Telegram changes without restart", async () => {
  const raw = JSON.parse(await readFile("config.example.json", "utf8"));
  delete raw.top_careless;
  raw.top_trending = { enabled: true };
  const appConfig = parseConfig(JSON.stringify(raw));
  assert.deepEqual(appConfig.top_careless, { ...config, min_market_cap_usd: 1_500_000 });
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
    const rejected = await noKey.onCommand("/config", ["set", "top_careless.enabled", "true"]);
    assert.match(rejected?.text ?? "", /JUPITER_API_KEY/);
    assert.equal(appConfig.top_careless.enabled, false);
    const allowed = await noKey.onCommand("/config", ["set", "top_careless.limit", "25"]);
    assert.match(allowed?.text ?? "", /CONFIG DISIMPAN/);
    assert.equal(appConfig.top_careless.limit, 25);
    const swapRejected = await noKey.onCommand("/config", ["set", "swap.enabled", "true"]);
    assert.match(swapRejected?.text ?? "", /JUPITER_API_KEY/);
    assert.equal(appConfig.swap.enabled, false);
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
      if (url.hostname === "dlmm.datapi.meteora.ag") {
        poolRequests++;
        return Response.json({ pages: 1, data: Array.from({ length: count }, (_, i) => makePool(i + 1)) });
      }
      if (url.hostname === "api.jup.ag") return Response.json(Array.from({ length: count }, (_, i) => ({ ...makeToken(i + 1), symbol: "<".repeat(16), name: "&".repeat(32) })));
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
    assert.equal((text.match(/Simple Fee\/TVL 24j <b>1\.00%<\/b>/g) ?? []).length, count * 2);
    assert.equal((text.match(/Base fee 0\.10% · Bin step/g) ?? []).length, count * 2);
    assert.equal((text.match(/👛 Token: <b>/g) ?? []).length, count * 2);
    assert.equal((text.match(/🏊 Pool ini: <b>AKTIF<\/b>/g) ?? []).length, count > 0 ? 2 : 0);
    assert.doesNotMatch(text, /BELUM TERVERIFIKASI/);

    for (const { body } of rendered) {
      assert.deepEqual(body.link_preview_options, { is_disabled: true });
      assert.ok(body.text.length <= 3500);
      assert.doesNotMatch(body.text, /<<<<|&&&&/);
      assert.match(body.text, /&lt;|&amp;|APR/);
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
