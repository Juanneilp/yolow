import assert from "node:assert/strict";
import test from "node:test";
import { fetchTopTrending, formatTopTrending, selectTopTrending, type TopTrendingConfig } from "../src/market-data/top-trending.ts";

const now = Date.parse("2026-10-03T00:00:00Z");
const config: TopTrendingConfig = {
  limit: 10,
  min_market_cap_usd: 500_000,
  min_token_age_hours: 6,
  max_token_age_days: 60,
  min_holders: 1_000,
  min_tvl_usd: 10_000,
  min_organic_score: 70,
};

function makePool(mint: string, overrides: Record<string, unknown> = {}) {
  return {
    address: `pool-${mint}`,
    tvl: 20_000,
    volume: { "24h": 50_000 },
    token_x: { address: mint, symbol: mint, name: mint, market_cap: 700_000, holders: 1_200 },
    token_y: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", market_cap: 50_000_000_000, holders: 2_000_000 },
    ...overrides,
  };
}

function makeJupiter(mint: string, ageHours = 6, organicScore = 80) {
  return {
    id: mint,
    name: `${mint} token`,
    symbol: mint,
    organicScore,
    firstPool: { createdAt: new Date(now - ageHours * 3_600_000).toISOString() },
  };
}

test("requires every threshold, including minimum age, holders, TVL, and Organic Score", () => {
  const pools = [
    makePool("pass"),
    makePool("too-young"),
    makePool("low-score"),
    makePool("low-market-cap", { token_x: { address: "low-market-cap", market_cap: 499_999, holders: 2_000 } }),
    makePool("low-holders", { token_x: { address: "low-holders", market_cap: 700_000, holders: 999 } }),
    makePool("low-tvl", { tvl: 9_999 }),
  ];
  const jupiter = new Map([
    ["pass", makeJupiter("pass", 6, 70)],
    ["too-young", makeJupiter("too-young", 5.99, 99)],
    ["low-score", makeJupiter("low-score", 10, 69.99)],
  ]);

  const result = selectTopTrending(pools as any[], jupiter, config, now);
  assert.deepEqual(result.map((token) => token.mint), ["pass"]);
});

test("includes tokens up to 60 days old and excludes older tokens", () => {
  const pools = [makePool("at-limit"), makePool("over-limit")];
  const jupiter = new Map([
    ["at-limit", makeJupiter("at-limit", 60 * 24)],
    ["over-limit", makeJupiter("over-limit", 60 * 24 + 1)],
  ]);

  const result = selectTopTrending(pools as any[], jupiter, config, now);
  assert.deepEqual(result.map((token) => token.mint), ["at-limit"]);
});

test("deduplicates by mint, keeps the highest-volume DLMM pool, and ranks descending", () => {
  const pools = [
    makePool("first", { volume: { "24h": 30_000 } }),
    makePool("second", { volume: { "24h": 40_000 } }),
    makePool("first", { address: "better-first-pool", volume: { "24h": 60_000 }, tvl: 25_000 }),
  ];
  const jupiter = new Map([
    ["first", makeJupiter("first")],
    ["second", makeJupiter("second")],
  ]);

  const result = selectTopTrending(pools as any[], jupiter, config, now);
  assert.deepEqual(result.map((token) => token.mint), ["first", "second"]);
  assert.equal(result[0].poolAddress, "better-first-pool");
  assert.equal(result[0].volume24h, 60_000);
});

test("includes only SOL-quoted pools and never shows stablecoin quote mints as candidates", () => {
  const pools = [
    makePool("meme-usdc", { token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", market_cap: 1_000_000, holders: 10_000 } }),
    makePool("meme-usdt", { token_y: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", market_cap: 1_000_000, holders: 10_000 } }),
    makePool("reverse-sol", {
      token_x: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
      token_y: { address: "reverse-sol", symbol: "RVS", name: "Reverse", market_cap: 1_000_000, holders: 10_000 },
    }),
  ];
  const jupiter = new Map([
    ["reverse-sol", makeJupiter("reverse-sol")],
  ]);

  const result = selectTopTrending(pools as any[], jupiter, config, now);
  assert.deepEqual(result.map((token) => token.mint), ["reverse-sol"]);
  assert.equal(result[0].pair, "RVS/SOL");
});

test("renders a Telegram-friendly card and escapes token metadata", () => {
  const mint = "6GmAFS123456789ABCDEFGHJKLMNPQRSTUVWXYZUNgx";
  const pool = "zxTpi4123456789ABCDEFGHJKLMNPQRSTUVWXYZSCLX";
  const pools = [makePool(mint, {
    address: pool,
    token_x: { address: mint, symbol: "<TAG>", name: "<i>not markup</i>", market_cap: 700_000, holders: 1_200 },
  })];
  const jupiter = makeJupiter(mint);
  jupiter.name = "<i>not markup</i>";
  const result = selectTopTrending(pools as any[], new Map([[mint, jupiter]]), config, now);
  const text = formatTopTrending(result, config, new Date(now));
  assert.match(text, /🔥 <b>TOP TRENDING<\/b>/);
  assert.match(text, /Umur 6 jam–60 hari/);
  assert.match(text, /ATH MC <b>N\/A<\/b> · turun <b>N\/A<\/b>/);
  assert.match(text, /&lt;TAG&gt;/);
  assert.match(text, /&lt;i&gt;not markup&lt;\/i&gt;/);
  assert.doesNotMatch(text, /<i>not markup<\/i>/);
  assert.ok(text.includes(`CA <code>${mint}</code> · Pool <code>${pool}</code>`));
});

test("loads Meteora candidates and enriches them with Jupiter and GMGN data", async () => {
  const originalFetch = globalThis.fetch;
  const requested: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(url);
    if (url.hostname === "dlmm.datapi.meteora.ag") {
      return new Response(JSON.stringify({ data: [makePool("candidate")], pages: 1 }), { status: 200 });
    }
    if (url.hostname === "api.jup.ag") {
      assert.equal(url.pathname, "/tokens/v2/search");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-api-key");
      return new Response(JSON.stringify([makeJupiter("candidate", 24)]), { status: 200 });
    }
    assert.equal(url.hostname, "openapi.gmgn.ai");
    assert.equal(url.pathname, "/v1/market/rank");
    assert.equal(new Headers(init?.headers).get("x-apikey"), "gmgn-test-key");
    return new Response(JSON.stringify({
      code: 0,
      data: { rank: [{ address: "candidate", history_highest_market_cap: "1000000" }] },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchTopTrending(
      config,
      "test-api-key",
      "https://dlmm.datapi.meteora.ag",
      "https://api.jup.ag/tokens/v2",
      "gmgn-test-key",
    );
    assert.deepEqual(result.map((token) => token.mint), ["candidate"]);
    assert.equal(result[0].athMarketCapUsd, 1_000_000);
    assert.equal(result[0].dropFromAthPercent, 30);
    assert.equal(requested[0].searchParams.get("sort_by"), "volume_24h:desc");
    assert.equal(requested[0].searchParams.get("filter_by"), "tvl>=10000");
    assert.equal(requested[1].searchParams.get("query"), "candidate");
    assert.equal(requested[2].searchParams.get("chain"), "sol");
    assert.equal(requested[2].searchParams.get("interval"), "24h");
    assert.equal(requested[2].searchParams.get("order_by"), "volume");
    assert.equal(requested[2].searchParams.get("limit"), "100");
    assert.match(requested[2].searchParams.get("client_id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.ok(Number(requested[2].searchParams.get("timestamp")) > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps Top Trending available without GMGN_API_KEY and marks ATH unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    return url.hostname === "dlmm.datapi.meteora.ag"
      ? new Response(JSON.stringify({ data: [makePool("candidate")], pages: 1 }), { status: 200 })
      : new Response(JSON.stringify([makeJupiter("candidate", 24)]), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchTopTrending(
      config,
      "test-api-key",
      "https://dlmm.datapi.meteora.ag",
      "https://api.jup.ag/tokens/v2",
    );
    assert.deepEqual(result.map((token) => token.mint), ["candidate"]);
    assert.ok(!hosts.includes("openapi.gmgn.ai"));
    assert.match(formatTopTrending(result, config), /ATH MC <b>N\/A<\/b>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
