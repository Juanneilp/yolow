import { PublicKey } from "@solana/web3.js";
import { escapeHtml, readJsonResponse, redactSecrets } from "../security.ts";
import { SOL_MINT } from "../positions/monitor.ts";
import type { Position } from "../domain/types.ts";

type Token = {
  address?: string; name?: string; symbol?: string;
  market_cap?: number | string; created_at?: number;
  organic_score?: number; holders?: number;
};
type Pool = {
  pool_address?: string; pool_type?: string;
  token_x?: Token; token_y?: Token;
  tvl?: number | string; active_tvl?: number | string;
  volume?: number | string; fee_pct?: number | string;
  fee_active_tvl_ratio?: number | string;
  base_token_holders?: number;
  dlmm_params?: { bin_step?: number };
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
  enabled: boolean; limit: number;
  min_market_cap_usd: number; min_token_age_days: number; min_tvl_usd: number;
  min_organic_score: number; min_holders: number;
  min_fee_active_tvl_24h_percent: number; min_bin_step: number;
  blacklisted_mints: string[];
};

export type CarelessPool = {
  address: string; mint: string; symbol: string; name: string;
  marketCapUsd: number; ageDays: number; tvlUsd: number; activeTvlUsd: number;
  volume24h: number; baseFeePercent: number; feeActiveTvl24hPercent: number;
  organicScore: number; holders: number; binStep: number;
};

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

export function selectTopCareless(pools: Pool[], config: TopCarelessConfig, now = Date.now()): CarelessPool[] {
  const selected = new Map<string, CarelessPool>();
  for (const pool of pools) {
    const solIsX = pool.token_x?.address === SOL_MINT;
    const token = solIsX ? pool.token_y : pool.token_y?.address === SOL_MINT ? pool.token_x : undefined;
    if (pool.pool_type !== "dlmm" || !token?.address || token.address === SOL_MINT || !pool.pool_address ||
        config.blacklisted_mints.includes(token.address)) continue;
    try { new PublicKey(token.address); new PublicKey(pool.pool_address); } catch { continue; }
    const cap = numeric(token.market_cap), tvl = numeric(pool.tvl), activeTvl = numeric(pool.active_tvl);
    const volume = numeric(pool.volume), fee = numeric(pool.fee_pct), ratio = numeric(pool.fee_active_tvl_ratio);
    const step = pool.dlmm_params?.bin_step, holders = solIsX ? token.holders : pool.base_token_holders;
    const ageDays = Number.isSafeInteger(token.created_at) && token.created_at! > 0 ? (now - token.created_at!) / 86_400_000 : NaN;
    const scores = [pool.token_x?.organic_score, pool.token_y?.organic_score];
    if (cap === undefined || cap < config.min_market_cap_usd || tvl === undefined || tvl <= 0 || tvl < config.min_tvl_usd ||
        activeTvl === undefined || activeTvl <= 0 || volume === undefined || fee === undefined || fee > 100 ||
        ratio === undefined || ratio < config.min_fee_active_tvl_24h_percent ||
        !Number.isSafeInteger(step) || step! < config.min_bin_step ||
        !Number.isSafeInteger(holders) || holders! < config.min_holders || holders! < 0 ||
        !Number.isFinite(ageDays) || ageDays < 0 || ageDays < config.min_token_age_days ||
        scores.some((score) => typeof score !== "number" || !Number.isFinite(score) || score < config.min_organic_score || score < 0 || score > 100)) continue;
    selected.set(pool.pool_address, {
      address: pool.pool_address, mint: token.address,
      symbol: typeof token.symbol === "string" && token.symbol ? token.symbol : "UNKNOWN",
      name: typeof token.name === "string" && token.name ? token.name : "Unknown token",
      marketCapUsd: cap, ageDays, tvlUsd: tvl, activeTvlUsd: activeTvl,
      volume24h: volume, baseFeePercent: fee, feeActiveTvl24hPercent: ratio,
      organicScore: token.organic_score!, holders: holders!, binStep: step!,
    });
  }
  return [...selected.values()].sort((a, b) => b.feeActiveTvl24hPercent - a.feeActiveTvl24hPercent ||
    b.volume24h - a.volume24h || a.address.localeCompare(b.address)).slice(0, config.limit);
}

export async function fetchTopCareless(config: TopCarelessConfig, eligibility: { excludedMints?: Set<string>; minBinStep?: number } = {}): Promise<{ pools: CarelessPool[]; limited: boolean }> {
  const pools: Pool[] = [];
  const now = Date.now();
  const effective = { ...config, min_bin_step: Math.max(config.min_bin_step, eligibility.minBinStep ?? 0) };
  const filters = ["pool_type=dlmm", `tvl>=${config.min_tvl_usd}`, `fee_active_tvl_ratio>=${config.min_fee_active_tvl_24h_percent}`,
    `base_token_market_cap>=${config.min_market_cap_usd}`, `base_token_holders>=${config.min_holders}`,
    `base_token_organic_score>=${config.min_organic_score}`, `quote_token_organic_score>=${config.min_organic_score}`,
    `base_token_created_at<=${Math.floor(now - config.min_token_age_days * 86_400_000)}`, `dlmm_bin_step>=${effective.min_bin_step}`];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const url = new URL("https://pool-discovery-api.datapi.meteora.ag/pools");
    url.search = new URLSearchParams({ category: "all", page_size: "100", timeframe: "24h",
      sort_by: "fee_active_tvl_ratio:desc,volume:desc", filter_by: filters.join("&&"), ...(cursor ? { after_key: cursor } : {}) }).toString();
    const body = await getJson<{ data?: Pool[]; has_more?: boolean; after_key?: string }>(url);
    if (!body || !Array.isArray(body.data) || body.data.length > 100 || typeof body.has_more !== "boolean" ||
        body.data.some((pool) => !pool || typeof pool !== "object") ||
        (body.has_more && (!body.data.length || typeof body.after_key !== "string" || !body.after_key || body.after_key.length > 8192 || seen.has(body.after_key)))) {
      throw new Error("Respons daftar pool Meteora tidak sesuai format");
    }
    pools.push(...body.data.filter((pool) => !eligibility.excludedMints?.has(
      pool.token_x?.address === SOL_MINT ? pool.token_y?.address ?? "" : pool.token_x?.address ?? "")));
    if (!body.has_more) return { pools: selectTopCareless(pools, effective, now), limited: false };
    cursor = body.after_key!; seen.add(cursor);
  }
  return { pools: selectTopCareless(pools, effective, now), limited: true };
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
    `MCap ≥ ${usd(config.min_market_cap_usd)} · Umur ≥ ${config.min_token_age_days * 24} jam`,
    `TVL ≥ ${usd(config.min_tvl_usd)} · Bin step ≥ ${config.min_bin_step}`,
    `Organic Score ≥ ${config.min_organic_score} · Holders ≥ ${config.min_holders}`,
    `Fee/Active TVL 24j ≥ ${percent(config.min_fee_active_tvl_24h_percent)} · Maks. ${config.limit} pool`,
    `🚫 Blacklist manual: ${config.blacklisted_mints.length} token · /blacklist`,
    "",
    "📊 Urut Fee/Active TVL 24j, lalu volume 24j terbesar",
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
    `💎 Fee/Active TVL 24j <b>${percent(pool.feeActiveTvl24hPercent)}</b>`,
    `💧 TVL <b>${usd(pool.tvlUsd)}</b> · 📊 Volume 24j <b>${usd(pool.volume24h)}</b>`,
    `💵 MCap <b>${usd(pool.marketCapUsd)}</b> · 🕓 Umur <b>${(pool.ageDays * 24).toFixed(1)} jam</b>`,
    `🧬 Organic Score <b>${pool.organicScore.toFixed(2)}</b> · Holders <b>${pool.holders}</b>`,
    `💦 Active TVL <b>${usd(pool.activeTvlUsd)}</b>`,
    `⚙️ Base fee ${percent(pool.baseFeePercent)} · Bin step <b>${pool.binStep ?? "Belum tersedia"}</b>`,
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
    "<i>Fee/Active TVL 24j memakai fee_active_tvl_ratio dari Meteora Pool Discovery, dalam persen.</i>",
    "<i>Active TVL adalah likuiditas aktif/in-range; berbeda dari total TVL. Umur, Organic Score Jupiter dan holders mengikuti data pada web Meteora.</i>",
    "<i>Angka pool bukan jaminan hasil posisi. Screening hanya pasangan SOL.</i>");
  if (wallet) lines.push("<i>Penanda memakai posisi nyata yang masih terbuka pada sinkronisasi terakhir. Token dicocokkan berdasarkan mint, pool berdasarkan alamat. Posisi yang diabaikan tetap dihitung; posisi virtual tidak dihitung.</i>");
  return lines.join("\n");
}
