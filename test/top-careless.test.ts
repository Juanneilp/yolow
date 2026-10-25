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
import { openDatabase } from "../src/storage/db.ts";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const sol = "So11111111111111111111111111111111111111112";
const now = Date.UTC(2026, 9, 21);
const config: TopCarelessConfig = { enabled: true, limit: 10, min_market_cap_usd: 1_500_000, min_token_age_days: 3, min_tvl_usd: 5000 };
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

for (const count of [1, 10]) {
  test(`Careless keyboard button and callback render ${count} pools safely, keep filters and enforce authorization`, async (t) => {
    t.mock.method(Date, "now", () => now);
    t.mock.method(console, "log", () => {});
    const appConfig = parseConfig(await readFile("config.example.json", "utf8"));
    const db = openDatabase(":memory:"); t.after(() => db.close());
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
    if (count === 1) assert.ok(rendered.some(reply => reply.method === "editMessageText"));
    else assert.ok(rendered.length > 2);
  });
}
