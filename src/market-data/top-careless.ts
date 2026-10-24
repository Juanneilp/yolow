import { PublicKey } from "@solana/web3.js";
import { escapeHtml, redactSecrets } from "../security.ts";
import { SOL_MINT } from "../positions/monitor.ts";
import { getJson, type Pool, type JupiterToken } from "./top-trending.ts";

export type TopCarelessConfig = {
  enabled: boolean;
  limit: number;
  min_market_cap_usd: number;
  min_token_age_days: number;
  min_tvl_usd: number;
};

export type CarelessPool = {
  address: string;
  mint: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  ageDays: number;
  tvlUsd: number;
  volume24h: number;
  baseFeePercent: number;
  simpleFeeTvl24hPercent: number;
  feeTvl24hPercent?: number;
  aprPercent?: number;
  binStep?: number;
};

const comparePools = (a: CarelessPool, b: CarelessPool) => b.simpleFeeTvl24hPercent - a.simpleFeeTvl24hPercent || b.volume24h - a.volume24h || a.address.localeCompare(b.address);

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function candidate(pool: Pool, config: TopCarelessConfig) {
  const tvl = numeric(pool.tvl);
  const token = pool.token_x?.address === SOL_MINT ? pool.token_y
    : pool.token_y?.address === SOL_MINT ? pool.token_x : undefined;
  if (typeof token?.address !== "string" || token.address === SOL_MINT || typeof pool.address !== "string" ||
    tvl === undefined || tvl <= 0 || tvl < config.min_tvl_usd ||
    (numeric(token.market_cap) ?? -1) < config.min_market_cap_usd) return undefined;
  try { new PublicKey(token.address); new PublicKey(pool.address); }
  catch { return undefined; }
  return token;
}

export function selectTopCareless(pools: Pool[], tokens: Map<string, JupiterToken>, config: TopCarelessConfig, now = Date.now()): CarelessPool[] {
  const selected = new Map<string, CarelessPool>();
  for (const pool of pools) {
    const token = candidate(pool, config);
    if (!token) continue;
    const metadata = tokens.get(token.address!);
    const createdAt = typeof metadata?.firstPool?.createdAt === "string" ? Date.parse(metadata.firstPool.createdAt) : NaN;
    const ageDays = (now - createdAt) / 86_400_000;
    const volume = numeric(pool.volume?.["24h"]);
    const baseFeePercent = numeric(pool.pool_config?.base_fee_pct);
    const ratio = numeric(pool.fee_tvl_ratio?.["24h"]);
    if (!Number.isFinite(ageDays) || ageDays < config.min_token_age_days || ageDays < 0 ||
      volume === undefined || baseFeePercent === undefined || baseFeePercent > 100) continue;
    // Base fee is a percentage, so /100 for the fee and ×100 for Fee/TVL cancel out.
    const simpleFeeTvl24hPercent = volume / numeric(pool.tvl)! * baseFeePercent;
    if (!Number.isFinite(simpleFeeTvl24hPercent)) continue;
    selected.set(pool.address!, {
      address: pool.address!, mint: token.address!,
      symbol: typeof metadata?.symbol === "string" && metadata.symbol ? metadata.symbol : typeof token.symbol === "string" && token.symbol ? token.symbol : "UNKNOWN",
      name: typeof metadata?.name === "string" && metadata.name ? metadata.name : typeof token.name === "string" && token.name ? token.name : "Unknown token",
      marketCapUsd: numeric(token.market_cap)!,
      ageDays, tvlUsd: numeric(pool.tvl)!, volume24h: volume,
      baseFeePercent, simpleFeeTvl24hPercent,
      // The API ratio is already a percentage; annualize once without compounding.
      ...(ratio === undefined ? {} : { feeTvl24hPercent: ratio }),
      ...(ratio !== undefined && Number.isFinite(ratio * 365) ? { aprPercent: ratio * 365 } : {}),
      ...(Number.isSafeInteger(pool.pool_config?.bin_step) && pool.pool_config!.bin_step! > 0
        ? { binStep: pool.pool_config!.bin_step } : {}),
    });
  }
  return [...selected.values()].sort(comparePools)
    .slice(0, config.limit);
}

export async function fetchTopCareless(config: TopCarelessConfig, apiKey: string, meteoraBaseUrl: string, jupiterTokensBaseUrl: string): Promise<{ pools: CarelessPool[]; limited: boolean }> {
  const selected = new Map<string, CarelessPool>();
  const tokens = new Map<string, JupiterToken>();
  const queried = new Set<string>();
  const now = Date.now();
  let pages = 1;
  let limited = false;
  for (let page = 1; page <= Math.min(pages, 20); page++) {
    const url = new URL("/pools", meteoraBaseUrl);
    url.search = new URLSearchParams({ page: String(page), page_size: "100",
      sort_by: "fee_tvl_ratio_24h:desc,volume_24h:desc", filter_by: `tvl>=${config.min_tvl_usd}` }).toString();
    const body = await getJson<{ data?: Pool[]; pages?: number }>(url);
    if (!Array.isArray(body.data) || body.data.length > 100 || !Number.isSafeInteger(body.pages) || body.pages! < 0 ||
      body.data.some((pool) => !pool || typeof pool !== "object")) throw new Error("Respons daftar pool Meteora tidak sesuai format");
    pages = body.pages!;
    if (page === 20 && pages > page) limited = true;
    if (!body.data.length) break;
    const mints = [...new Set(body.data.flatMap((pool) => {
      const token = candidate(pool, config);
      return token && !queried.has(token.address!) ? [token.address!] : [];
    }))];
    for (let offset = 0; offset < mints.length; offset += 100) {
      const batch = mints.slice(offset, offset + 100);
      const tokenUrl = new URL(`${jupiterTokensBaseUrl.replace(/\/$/, "")}/search`);
      tokenUrl.searchParams.set("query", batch.join(","));
      const metadata = await getJson<JupiterToken[]>(tokenUrl, { "x-api-key": apiKey });
      if (!Array.isArray(metadata)) throw new Error("Respons token Jupiter tidak sesuai format");
      for (const mint of batch) queried.add(mint);
      for (const token of metadata) if (token && typeof token.id === "string" && batch.includes(token.id)) tokens.set(token.id, token);
    }
    for (const pool of selectTopCareless(body.data, tokens, config, now)) selected.set(pool.address, pool);
  }
  return { pools: [...selected.values()].sort(comparePools).slice(0, config.limit), limited };
}

export function formatTopCareless(result: { pools: CarelessPool[]; limited: boolean }, config: TopCarelessConfig, timezone: string, updatedAt = new Date()): string {
  const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
  const label = (value: string, max = 32) => escapeHtml(redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max));
  const percent = (value: number | undefined) => value === undefined ? "Belum tersedia"
    : `${value > 0 && value < 0.01 ? "&lt;0.01" : value.toFixed(2)}%`;
  const lines = [
    `🧪 <b>TOP CARELESS STRAT</b> <code>${result.pools.length}/${config.limit}</code>`,
    `🔎 MCap ≥ ${usd(config.min_market_cap_usd)} · Umur ≥ ${config.min_token_age_days} hari · TVL ≥ ${usd(config.min_tvl_usd)}`,
    "📊 Pool /SOL · Urut Simple Fee/TVL 24j, lalu volume 24j terbesar",
    `🕒 Data ${new Intl.DateTimeFormat("id-ID", { timeZone: timezone, dateStyle: "medium", timeStyle: "medium" }).format(updatedAt)}`,
    "━━━━━━━━━━━━━━━━━━",
  ];
  for (const [index, pool] of result.pools.entries()) lines.push(
    `<b>${index + 1}. ${label(pool.symbol, 16)}/SOL</b> · ${label(pool.name)}`,
    `💵 MCap ${usd(pool.marketCapUsd)} · 🕓 ${pool.ageDays.toFixed(1)} hari · 💧 TVL ${usd(pool.tvlUsd)}`,
    `📈 Volume 24j ${usd(pool.volume24h)} · APR estimasi <b>${percent(pool.aprPercent)}</b>`,
    `Base fee ${percent(pool.baseFeePercent)} · Simple Fee/TVL 24j <b>${percent(pool.simpleFeeTvl24hPercent)}</b>`,
    `Fee/TVL 24j ${percent(pool.feeTvl24hPercent)} · Bin step <b>${pool.binStep ?? "Belum tersedia"}</b>`,
    `CA <code>${escapeHtml(pool.mint)}</code>`,
    `Pool <code>${escapeHtml(pool.address)}</code>`,
    `<a href="https://app.meteora.ag/dlmm/${encodeURIComponent(pool.address)}">Buka Meteora DLMM</a>`,
    "━━━━━━━━━━━━━━━━━━",
  );
  if (!result.pools.length) lines.push("Belum ada pool yang memenuhi semua filter.");
  if (result.limited) lines.push("⚠️ Cakupan terbatas: batas 20 halaman × 100 pool tercapai; ranking hanya dari pool yang diperiksa.");
  else if (result.pools.length < config.limit) lines.push(`ℹ️ Hanya ${result.pools.length} pool memenuhi semua filter.`);
  lines.push("Simple Fee/TVL 24j = Volume 24j × Base fee (%) ÷ TVL. Estimasi belum memperhitungkan dynamic fee atau potongan protokol. APR = Fee/TVL 24j × 365, tanpa farm reward; bukan jaminan hasil posisi. Umur berdasarkan firstPool Jupiter.");
  return lines.join("\n");
}
