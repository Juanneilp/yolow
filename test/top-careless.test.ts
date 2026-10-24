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
const config: TopCarelessConfig = { enabled: true, limit: 10, min_market_cap_usd: 1_000_000, min_token_age_days: 3, min_tvl_usd: 5000 };
const makePool = (n = 1, overrides = {}) => ({
  address: key(n + 100), token_x: { address: key(n), market_cap: 1_000_000, symbol: "TOKEN", name: "Token" },
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
  assert.equal(selectTopCareless([makePool(1, { token_x: { ...makePool().token_x, market_cap: 999_999 } })], metadata, config, now).length, 0);
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
  assert.match(formatTopCareless({ pools: [pool], limited: false }, config, "Asia/Jakarta"), /Base fee 0\.30% · Simple Fee\/TVL 24j <b>3\.00%<\/b>/);
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

test("Careless bounds scanning and rejects malformed, timed out and rate limited responses", async (t) => {
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
  for (const body of [{ data: [], pages: -1 }, { data: [null], pages: 1 }, { data: {}, pages: 1 }, { data: [], pages: 1.1 }]) {
    response = body;
    await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), /tidak sesuai format/);
  }
  status = 429;
  await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), /HTTP 429/);
  fails = true;
  await assert.rejects(fetchTopCareless(config, "fake-api-key", poolsUrl, tokensUrl), error => {
    assert.doesNotMatch(String(error), /fake-api-key/); return true;
  });
});

test("Careless config defaults old files, validates filters and persists Telegram changes without restart", async () => {
  const raw = JSON.parse(await readFile("config.example.json", "utf8"));
  delete raw.top_careless;
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
    appConfig.swap.enabled = false; appConfig.top_trending.enabled = false;
    const noKey = handlerFor(db, appConfig, undefined, path);
    const rejected = await noKey.onCommand("/config", ["set", "top_careless.enabled", "true"]);
    assert.match(rejected?.text ?? "", /JUPITER_API_KEY/);
    assert.equal(appConfig.top_careless.enabled, false);
    assert.match((await noKey.onCommand("/topcareless", []))?.text ?? "", /dinonaktifkan/);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const count of [1, 10]) {
  test(`Careless command and callback render ${count} pools safely, keep filters and enforce authorization`, async (t) => {
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
          { update_id: 1, message: { ...message, text: "/topcareless" } },
          { update_id: 2, callback_query: { id: "refresh", from: message.from, message, data: "cmd:/topcareless" } },
          { update_id: 3, callback_query: { id: "filter", from: message.from, message, data: "config:section:careless" } },
          { update_id: 4, message: { ...message, from: { id: 99 }, text: "/topcareless" } },
        ] });
      }
      const body = JSON.parse(String(init?.body));
      if (["sendMessage", "editMessageText"].includes(method)) replies.push({ method, body });
      return Response.json({ ok: true, result: true });
    });
    await runBot({ token: "123:test", chatId: "42", config: appConfig.top_trending, jupiterApiKey: "fake-api-key",
      meteoraBaseUrl: poolsUrl, jupiterTokensBaseUrl: tokensUrl, signal: shutdown.signal,
      onCommand: handler.onCommand, onCallback: handler.onCallback });
    assert.equal(poolRequests, 2);
    const rendered = replies.filter(reply => reply.body.parse_mode === "HTML");
    const text = rendered.map(reply => reply.body.text).join("\n");
    assert.equal((text.match(/Buka Meteora DLMM/g) ?? []).length, count * 2);
    assert.equal((text.match(/Base fee 0\.10% · Simple Fee\/TVL 24j <b>1\.00%<\/b>/g) ?? []).length, count * 2);
    for (const { body } of rendered) {
      assert.deepEqual(body.link_preview_options, { is_disabled: true });
      assert.ok(body.text.length <= 3500);
      assert.doesNotMatch(body.text, /<<<<|&&&&/);
      assert.match(body.text, /&lt;|&amp;|APR/);
    }
    assert.ok(rendered[0].body.reply_markup.inline_keyboard.flat().some((button: any) => button.callback_data === "config:section:careless"));
    assert.match(replies.at(-1)!.body.text, /top_careless.min_tvl_usd = 5000/);
    if (count === 1) assert.ok(rendered.some(reply => reply.method === "editMessageText"));
    else assert.ok(rendered.length > 2);
  });
}
