import { readJsonResponse } from "../security.ts";

export type TokenInfo = { name?: string; symbol?: string };

type JupiterToken = TokenInfo & { id?: string };
const cache = new Map<string, TokenInfo | null>();

function clean(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
  return result || undefined;
}

export async function fetchTokenInfo(
  mints: string[],
  apiKey: string | undefined,
  tokensBaseUrl: string,
): Promise<Map<string, TokenInfo>> {
  const unique = [...new Set(mints)];
  const missing = unique.filter((mint) => !cache.has(mint));
  if (apiKey?.trim() && missing.length) {
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const url = new URL(`${tokensBaseUrl.replace(/\/$/, "")}/search`);
      url.searchParams.set("query", batch.join(","));
      try {
        const response = await fetch(url, {
          headers: { "x-api-key": apiKey.trim() },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) continue;
        const tokens = await readJsonResponse<JupiterToken[]>(response);
        if (!Array.isArray(tokens)) continue;
        const requested = new Set(batch);
        for (const token of tokens) {
          if (!token.id || !requested.has(token.id)) continue;
          const info = { name: clean(token.name, 32), symbol: clean(token.symbol, 16) };
          if (info.name || info.symbol) cache.set(token.id, info);
        }
        for (const mint of batch) if (!cache.has(mint)) cache.set(mint, null);
      } catch { /* token labels are optional; keep the mint fallback */ }
    }
  }
  return new Map(unique.flatMap((mint) => {
    const info = cache.get(mint);
    return info ? [[mint, info]] : [];
  }));
}

export function tokenLabel(mint: string, info?: TokenInfo): string {
  if (info?.symbol && info.name && info.symbol !== info.name) {
    return `${info.symbol} · ${info.name}`;
  }
  return info?.symbol ?? info?.name ?? `Mint ${mint.slice(0, 5)}…${mint.slice(-5)}`;
}
