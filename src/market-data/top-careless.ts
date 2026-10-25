import { PublicKey } from "@solana/web3.js";
import { escapeHtml, readJsonResponse, redactSecrets } from "../security.ts";
import { SOL_MINT } from "../positions/monitor.ts";
import type { Position } from "../domain/types.ts";

type Token = {
  address?: string;
  name?: string;
  symbol?: string;
  market_cap?: number | string;
};

type Pool = {
  address?: string;
  name?: string;
  token_x?: Token;
  token_y?: Token;
  tvl?: number | string;
  volume?: Record<string, number | string | undefined>;
  fee_tvl_ratio?: Record<string, number | string | undefined>;
  pool_config?: { bin_step?: number; base_fee_pct?: number | string };
};

type JupiterToken = {
  id?: string;
  name?: string;
  symbol?: string;
  firstPool?: { createdAt?: string };
};

export async function getJson<T>(url: URL, headers: Record<string, string> = {}): Promise<T> {
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error(`Sumber ${url.hostname} gagal diakses atau melewati batas waktu`);
    }
    if (response.status === 429) {
      const now = Date.now();
      const retryAfter = response.headers.get("retry-after")?.trim();
      const reset = response.headers.get("x-ratelimit-reset")?.trim();
      const delays = [
        retryAfter ? (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now) : NaN,
        reset ? Number(reset) * 1000 - now : NaN,
      ].filter((delay) => Number.isFinite(delay) && delay >= 0);
      const delay = delays.length ? Math.max(...delays) : (attempt + 1) * 1000;
      await response.body?.cancel().catch(() => undefined);
      if (attempt >= 2 || waitedMs + delay > 5000) {
        const hint = delays.length ? `dalam ${Math.max(1, Math.ceil(delay / 1000))} detik` : "beberapa saat lagi";
        throw new Error(`Sumber ${url.hostname} merespons HTTP 429. Coba Refresh ${hint}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      waitedMs += delay;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Sumber ${url.hostname} merespons HTTP ${response.status}`);
    }
    try {
      return await readJsonResponse<T>(response);
    } catch {
      throw new Error(`Sumber ${url.hostname} mengembalikan JSON yang tidak valid`);
    }
  }
}

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

export async function fetchTopCareless(config: TopCarelessConfig, apiKey: string, meteoraBaseUrl: string, jupiterTokensBaseUrl: string, eligibility: { excludedMints?: Set<string>; minBinStep?: number } = {}): Promise<{ pools: CarelessPool[]; limited: boolean }> {
  const pools: Pool[] = [];
  const mints = new Set<string>();
  const tokens = new Map<string, JupiterToken>();
  const now = Date.now();
  let pages = 1;
  let limited = false;
  for (let page = 1; page <= Math.min(pages, 20); page++) {
    const url = new URL("/pools", meteoraBaseUrl);
    url.search = new URLSearchParams({ page: String(page), page_size: "100",
      sort_by: "fee_tvl_ratio_24h:desc,volume_24h:desc", filter_by: `tvl>=${config.min_tvl_usd}` }).toString();
    const body = await getJson<{ data?: Pool[]; pages?: number }>(url);
    if (!body || !Array.isArray(body.data) || body.data.length > 100 || !Number.isSafeInteger(body.pages) || body.pages! < 0 ||
      body.data.some((pool) => !pool || typeof pool !== "object")) throw new Error("Respons daftar pool Meteora tidak sesuai format");
    pages = body.pages!;
    if (page === 20 && pages > page) limited = true;
    if (!body.data.length) break;
    for (const pool of body.data) {
      const token = candidate(pool, config);
      if (token && !eligibility.excludedMints?.has(token.address!) &&
          (eligibility.minBinStep === undefined || (Number.isSafeInteger(pool.pool_config?.bin_step) && pool.pool_config!.bin_step! >= eligibility.minBinStep))) {
        pools.push(pool);
        mints.add(token.address!);
      }
    }
  }
  const uniqueMints = [...mints];
  for (let offset = 0; offset < uniqueMints.length; offset += 100) {
    const batch = uniqueMints.slice(offset, offset + 100);
    const tokenUrl = new URL(`${jupiterTokensBaseUrl.replace(/\/$/, "")}/search`);
    tokenUrl.searchParams.set("query", batch.join(","));
    const metadata = await getJson<JupiterToken[]>(tokenUrl, { "x-api-key": apiKey });
    if (!Array.isArray(metadata)) throw new Error("Respons token Jupiter tidak sesuai format");
    for (const token of metadata) if (token && typeof token.id === "string" && batch.includes(token.id)) tokens.set(token.id, token);
  }
  return { pools: selectTopCareless(pools, tokens, config, now), limited };
}

export type CarelessWalletPositions = {
  positions: ReadonlyArray<Pick<Position, "id" | "pool" | "tokenMint" | "quoteMint" | "state">>;
  syncedAt?: number;
  discoveryFailed: boolean;
  pollIntervalSec: number;
};

export function formatTopCareless(result: { pools: CarelessPool[]; limited: boolean }, config: TopCarelessConfig, timezone: string, updatedAt = new Date(), wallet?: CarelessWalletPositions): string {
  const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
  const label = (value: string, max = 32) => escapeHtml(redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max));
  const percent = (value: number | undefined) => value === undefined ? "Belum tersedia"
    : `${value > 0 && value < 0.01 ? "&lt;0.01" : value.toFixed(2)}%`;
  const tokens = new Map<string, { count: number; pools: Set<string> }>();
  const pools = new Map<string, number>();
  for (const position of new Map(wallet?.positions.filter((item) => item.state === "OPEN").map((item) => [item.id, item])).values()) {
    pools.set(position.pool, (pools.get(position.pool) ?? 0) + 1);
    for (const mint of new Set([position.tokenMint, position.quoteMint])) {
      const token = tokens.get(mint) ?? { count: 0, pools: new Set<string>() };
      token.count++; token.pools.add(position.pool); tokens.set(mint, token);
    }
  }
  const hasSync = wallet?.syncedAt !== undefined && Number.isSafeInteger(wallet.syncedAt) && wallet.syncedAt > 0 && wallet.syncedAt <= updatedAt.getTime();
  const current = hasSync && !wallet!.discoveryFailed && updatedAt.getTime() - wallet!.syncedAt! <= wallet!.pollIntervalSec * 2000;
  const ownership = (pool: CarelessPool): string[] => {
    if (!wallet) return [];
    const token = tokens.get(pool.mint), count = pools.get(pool.address) ?? 0;
    const cached = current ? "" : " · data terakhir";
    const absent = current ? "BELUM ADA" : "BELUM TERVERIFIKASI";
    return [
      `👛 Token: <b>${token ? "SUDAH ADA" : absent}</b>${token ? ` · ${token.count} posisi di ${token.pools.size} pool${cached}` : ""}`,
      `🏊 Pool ini: <b>${count ? "AKTIF" : absent}</b>${count ? ` · ${count} posisi${cached}` : ""}`,
      "",
    ];
  };
  const lines = [
    "🧪 <b>TOP CARELESS STRAT</b>",
    `📋 <b>${result.pools.length}/${config.limit} pool</b> · Meteora DLMM · Pasangan SOL`,
    "",
    "🔎 <b>Filter aktif</b>",
    `MCap ≥ ${usd(config.min_market_cap_usd)} · Umur ≥ ${config.min_token_age_days} hari`,
    `TVL ≥ ${usd(config.min_tvl_usd)} · Maks. ${config.limit} pool`,
    "",
    "📊 Urut Simple Fee/TVL 24j, lalu volume 24j terbesar",
    `🕒 Diperbarui ${new Intl.DateTimeFormat("id-ID", { timeZone: timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(updatedAt)}`,
  ];
  if (wallet) {
    lines.push(`👛 Sinkronisasi wallet: ${hasSync ? new Intl.DateTimeFormat("id-ID", { timeZone: timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(wallet.syncedAt!)) : "Belum tersedia"}`);
    if (!current) lines.push("⚠️ Status posisi memakai data terakhir; penanda tanpa kecocokan belum terverifikasi.");
  }
  for (const [index, pool] of result.pools.entries()) lines.push(
    "",
    "━━━━━━━━━━━━━━━━━━",
    `${["🥇", "🥈", "🥉"][index] ?? "▫️"} <b>${index + 1}. ${label(pool.symbol, 16)}/SOL</b>`,
    `<i>${label(pool.name)}</i>`,
    "",
    ...ownership(pool),
    `💎 Simple Fee/TVL 24j <b>${percent(pool.simpleFeeTvl24hPercent)}</b>`,
    `💧 TVL <b>${usd(pool.tvlUsd)}</b> · 📊 Volume 24j <b>${usd(pool.volume24h)}</b>`,
    `💵 MCap <b>${usd(pool.marketCapUsd)}</b> · 🕓 Umur <b>${pool.ageDays.toFixed(1)} hari</b>`,
    `⚙️ Base fee ${percent(pool.baseFeePercent)} · Bin step <b>${pool.binStep ?? "Belum tersedia"}</b>`,
    `📈 APR estimasi <b>${percent(pool.aprPercent)}</b> · Fee/TVL 24j ${percent(pool.feeTvl24hPercent)}`,
    "",
    `CA <code>${escapeHtml(pool.mint)}</code>`,
    `Pool <code>${escapeHtml(pool.address)}</code>`,
    `↗️ <a href="https://app.meteora.ag/dlmm/${encodeURIComponent(pool.address)}">Buka Meteora DLMM</a>`,
  );
  lines.push("", "━━━━━━━━━━━━━━━━━━");
  if (!result.pools.length) lines.push("🔎 <b>Belum ada pool yang memenuhi semua filter.</b>", "Ubah Filter atau coba Refresh beberapa saat lagi.", "");
  if (result.limited) lines.push("⚠️ Cakupan terbatas: batas 20 halaman × 100 pool tercapai; ranking hanya dari pool yang diperiksa.");
  else if (result.pools.length < config.limit) lines.push(`ℹ️ Hanya ${result.pools.length} pool memenuhi semua filter.`);
  lines.push("", "ℹ️ <b>Cara baca</b>",
    "<i>Simple Fee/TVL 24j = Volume 24j × Base fee (%) ÷ TVL.</i>",
    "<i>Estimasi belum termasuk dynamic fee atau potongan protokol.</i>",
    "<i>APR = Fee/TVL 24j × 365, tanpa farm reward; bukan jaminan hasil posisi. Umur berdasarkan firstPool Jupiter.</i>");
  if (wallet) lines.push("<i>Penanda memakai posisi nyata yang masih terbuka pada sinkronisasi terakhir. Token dicocokkan berdasarkan mint, pool berdasarkan alamat. Posisi yang diabaikan tetap dihitung; posisi virtual tidak dihitung.</i>");
  return lines.join("\n");
}
