import { randomUUID } from "node:crypto";

export type TopTrendingConfig = {
  limit: number;
  min_market_cap_usd: number;
  min_token_age_hours: number;
  max_token_age_days: number;
  min_holders: number;
  min_tvl_usd: number;
  min_organic_score: number;
};

type Token = {
  address?: string;
  name?: string;
  symbol?: string;
  market_cap?: number | string;
  holders?: number | string;
};

type Pool = {
  address?: string;
  name?: string;
  token_x?: Token;
  token_y?: Token;
  tvl?: number | string;
  volume?: Record<string, number | string | undefined>;
};

type JupiterToken = {
  id?: string;
  name?: string;
  symbol?: string;
  organicScore?: number;
  firstPool?: { createdAt?: string };
};

type GmgnRankToken = {
  address?: string;
  history_highest_market_cap?: number | string;
};

export type TrendingToken = {
  mint: string;
  name: string;
  symbol: string;
  marketCapUsd: number;
  ageHours: number;
  holders: number;
  poolAddress: string;
  pair: string;
  tvlUsd: number;
  organicScore: number;
  volume24h: number;
  athMarketCapUsd?: number;
  dropFromAthPercent?: number;
};

const SOL_MINT = "So11111111111111111111111111111111111111112";
const NON_TOKEN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const GMGN_API_BASE_URL = "https://openapi.gmgn.ai";

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (value === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function tokenCandidates(pool: Pool, config: TopTrendingConfig): Token[] {
  if ((numeric(pool.tvl) ?? -1) < config.min_tvl_usd) return [];

  const candidate = pool.token_x?.address === SOL_MINT ? pool.token_y
    : pool.token_y?.address === SOL_MINT ? pool.token_x
      : undefined;
  if (!candidate?.address || NON_TOKEN_MINTS.has(candidate.address)) return [];
  return (numeric(candidate.market_cap) ?? -1) >= config.min_market_cap_usd
    && (numeric(candidate.holders) ?? -1) >= config.min_holders ? [candidate] : [];
}

export function selectTopTrending(
  pools: Pool[],
  jupiterTokens: Map<string, JupiterToken>,
  config: TopTrendingConfig,
  nowMs = Date.now(),
): TrendingToken[] {
  const selected = new Map<string, TrendingToken>();

  for (const pool of pools) {
    const tvlUsd = numeric(pool.tvl);
    const volume24h = numeric(pool.volume?.["24h"]);
    if (tvlUsd === undefined || volume24h === undefined || !pool.address) continue;

    for (const token of tokenCandidates(pool, config)) {
      const mint = token.address!;
      const jupiter = jupiterTokens.get(mint);
      const organicScore = numeric(jupiter?.organicScore);
      const createdAt = Date.parse(jupiter?.firstPool?.createdAt ?? "");
      if (organicScore === undefined || organicScore < config.min_organic_score || !Number.isFinite(createdAt)) continue;

      const ageHours = (nowMs - createdAt) / 3_600_000;
      if (ageHours < config.min_token_age_hours || ageHours > config.max_token_age_days * 24) continue;

      const result: TrendingToken = {
        mint,
        name: jupiter?.name || token.name || "Unknown token",
        symbol: jupiter?.symbol || token.symbol || "UNKNOWN",
        marketCapUsd: numeric(token.market_cap)!,
        ageHours,
        holders: numeric(token.holders)!,
        poolAddress: pool.address,
        pair: `${token.symbol || jupiter?.symbol || "?"}/SOL`,
        tvlUsd,
        organicScore,
        volume24h,
      };

      const previous = selected.get(mint);
      if (!previous || result.volume24h > previous.volume24h) selected.set(mint, result);
    }
  }

  return [...selected.values()]
    .sort((a, b) => b.volume24h - a.volume24h || a.symbol.localeCompare(b.symbol))
    .slice(0, config.limit);
}

async function getJson<T>(url: URL, headers: Record<string, string> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error(`Sumber ${url.hostname} gagal diakses atau melewati batas waktu`);
  }
  if (!response.ok) throw new Error(`Sumber ${url.hostname} merespons HTTP ${response.status}`);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Sumber ${url.hostname} mengembalikan JSON yang tidak valid`);
  }
}

function candidateMints(pools: Pool[], config: TopTrendingConfig): string[] {
  return [...new Set(pools.flatMap((pool) => tokenCandidates(pool, config)
    .map((token) => token.address!)))];
}

export async function fetchTopTrending(
  config: TopTrendingConfig,
  apiKey: string,
  meteoraBaseUrl: string,
  jupiterTokensBaseUrl: string,
  gmgnApiKey?: string,
): Promise<TrendingToken[]> {
  const meteoraUrl = new URL("/pools", meteoraBaseUrl);
  const jupiterBase = jupiterTokensBaseUrl.replace(/\/$/, "");
  const jupiterByMint = new Map<string, JupiterToken>();
  const queriedMints = new Set<string>();
  const selected = new Map<string, TrendingToken>();
  let page = 1;
  let pageCount = 1;
  const nowMs = Date.now();

  while (page <= pageCount) {
    const url = new URL(meteoraUrl);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    url.searchParams.set("sort_by", "volume_24h:desc");
    url.searchParams.set("filter_by", `tvl>=${config.min_tvl_usd}`);

    const response = await getJson<{ data?: Pool[]; pages?: number }>(url);
    if (!Array.isArray(response.data) || !Number.isInteger(response.pages) || response.pages! < 0) {
      throw new Error("Respons daftar pool Meteora tidak sesuai format");
    }
    pageCount = response.pages;
    if (response.data.length === 0) break;

    const mintBatch = candidateMints(response.data, config).filter((mint) => !queriedMints.has(mint));
    const batches: string[][] = [];
    for (let index = 0; index < mintBatch.length; index += 100) {
      batches.push(mintBatch.slice(index, index + 100));
    }

    const tokenResponses = await Promise.all(batches.map(async (mints) => {
      const url = new URL(`${jupiterBase}/search`);
      url.searchParams.set("query", mints.join(","));
      return getJson<JupiterToken[]>(url, { "x-api-key": apiKey });
    }));
    for (let index = 0; index < batches.length; index += 1) {
      for (const mint of batches[index]) queriedMints.add(mint);
      const tokens = tokenResponses[index];
      if (!Array.isArray(tokens)) throw new Error("Respons token Jupiter tidak sesuai format");
      for (const token of tokens) if (token.id) jupiterByMint.set(token.id, token);
    }

    for (const token of selectTopTrending(response.data, jupiterByMint, config, nowMs)) {
      const previous = selected.get(token.mint);
      if (!previous || token.volume24h > previous.volume24h) selected.set(token.mint, token);
    }
    if (selected.size >= config.limit || page >= pageCount) break;
    page += 1;
  }

  const results = [...selected.values()]
    .sort((a, b) => b.volume24h - a.volume24h || a.symbol.localeCompare(b.symbol))
    .slice(0, config.limit);

  if (!gmgnApiKey?.trim() || results.length === 0) return results;

  const gmgnUrl = new URL("/v1/market/rank", GMGN_API_BASE_URL);
  gmgnUrl.searchParams.set("chain", "sol");
  gmgnUrl.searchParams.set("interval", "24h");
  gmgnUrl.searchParams.set("order_by", "volume");
  gmgnUrl.searchParams.set("direction", "desc");
  gmgnUrl.searchParams.set("limit", "100");
  gmgnUrl.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  gmgnUrl.searchParams.set("client_id", randomUUID());

  try {
    const response = await getJson<{
      code?: number | string;
      data?: { rank?: GmgnRankToken[] };
    }>(gmgnUrl, { "X-APIKEY": gmgnApiKey.trim() });
    if (String(response.code) !== "0" || !Array.isArray(response.data?.rank)) {
      throw new Error("GMGN rank response is invalid");
    }

    const athByMint = new Map(response.data.rank.flatMap((token) => {
      const ath = numeric(token.history_highest_market_cap);
      return token.address && ath !== undefined && ath > 0 ? [[token.address, ath]] : [];
    }));
    return results.map((token) => {
      const athMarketCapUsd = athByMint.get(token.mint);
      return athMarketCapUsd === undefined ? token : {
        ...token,
        athMarketCapUsd,
        dropFromAthPercent: (athMarketCapUsd - token.marketCapUsd) / athMarketCapUsd * 100,
      };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.warn("GMGN ATH enrichment unavailable:", reason);
    return results;
  }
}

function cleanLabel(value: string, maxLength = 32): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTopTrending(
  tokens: TrendingToken[],
  config: TopTrendingConfig,
  updatedAt = new Date(),
): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(updatedAt);
  const lines = [
    `🔥 <b>TOP TRENDING</b> <code>${tokens.length}/${config.limit}</code>`,
    `🔎 MCap ≥ ${usdFormat.format(config.min_market_cap_usd)} · Umur ${config.min_token_age_hours} jam–${config.max_token_age_days} hari · Holder ≥ ${config.min_holders.toLocaleString("en-US")} · TVL ≥ ${usdFormat.format(config.min_tvl_usd)} · Organic ≥ ${config.min_organic_score}`,
    "📊 Meteora DLMM · Pool token/SOL saja · Urut volume 24 jam",
    `🕒 Data ${time} WIB`,
    "━━━━━━━━━━━━━━━━━━",
  ];

  if (tokens.length === 0) return `${lines.join("\n")}\nBelum ada token yang memenuhi semua filter.`;

  tokens.forEach((token, index) => {
    const age = token.ageHours < 24 ? `${token.ageHours.toFixed(1)} jam` : `${(token.ageHours / 24).toFixed(1)} hari`;
    const symbol = escapeHtml(cleanLabel(token.symbol, 16));
    const name = escapeHtml(cleanLabel(token.name));
    lines.push(
      `<b>${index + 1}. ${symbol}</b>${symbol === name ? "" : ` · ${name}`}`,
      `💵 MCap <b>${usdFormat.format(token.marketCapUsd)}</b> · 🕓 ${age} · 👥 ${token.holders.toLocaleString("en-US")}`,
      `ATH MC <b>${token.athMarketCapUsd === undefined ? "N/A" : usdFormat.format(token.athMarketCapUsd)}</b> · turun <b>${token.dropFromAthPercent === undefined ? "N/A" : `${token.dropFromAthPercent.toFixed(1)}%`}</b>`,
      `🔗 ${escapeHtml(cleanLabel(token.pair, 24))} · 💧 TVL ${usdFormat.format(token.tvlUsd)} · 🌱 Organic ${token.organicScore.toFixed(1)} · 📈 24j ${usdFormat.format(token.volume24h)}`,
      `CA <code>${escapeHtml(token.mint)}</code> · Pool <code>${escapeHtml(token.poolAddress)}</code>`,
      "━━━━━━━━━━━━━━━━━━",
    );
  });
  if (tokens.some((token) => token.athMarketCapUsd === undefined)) {
    lines.push("ℹ️ Data ATH MC GMGN tidak tersedia untuk sebagian token; periksa GMGN_API_KEY atau cakupan token.");
  }
  if (tokens.length < config.limit) lines.push(`ℹ️ Hanya ${tokens.length} token memenuhi semua filter.`);
  return lines.join("\n");
}
