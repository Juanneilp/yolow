import { PublicKey } from "@solana/web3.js";
import { readJsonResponse, safeError } from "../security.ts";

export type PositionPnl = {
  id: string;
  deposits: number | null;
  withdrawals: number | null;
  claimed: number | null;
  pnl: number | null;
  percent: number | null;
  updatedAt: number | null;
};

export type PoolPnl = {
  positions: Map<string, PositionPnl>;
  fetchedAt?: number;
  error?: string;
};

function amount(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) {
    throw new Error("Nilai SOL Meteora tidak valid");
  }
  return Number(value);
}

function timestamp(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000) {
    throw new Error("Waktu data Meteora tidak valid");
  }
  return value * 1000;
}

export class PositionPnlMonitor {
  private readonly cache = new Map<string, PoolPnl>();
  private readonly pending = new Map<string, Promise<PoolPnl>>();
  private readonly nextAttempt = new Map<string, number>();
  private readonly lastAttempt = new Map<string, number>();

  constructor(private readonly wallet: string, private readonly baseUrl: string) {}

  async refresh(pools: string[], force = false): Promise<Map<string, PoolPnl>> {
    const unique = [...new Set(pools)];
    const active = new Set(unique);
    for (const key of this.cache.keys()) if (!active.has(key)) {
      this.cache.delete(key);
      this.nextAttempt.delete(key);
      this.lastAttempt.delete(key);
    }
    const results = new Map<string, PoolPnl>();
    // Sequential pools keep background refreshes below the public API rate limit.
    for (const pool of unique) results.set(pool, await this.refreshPool(pool, force));
    return results;
  }

  private async refreshPool(pool: string, force: boolean): Promise<PoolPnl> {
    const pending = this.pending.get(pool);
    if (pending) return pending;
    const cached = this.cache.get(pool);
    const now = Date.now();
    if (cached && (now < (this.nextAttempt.get(pool) ?? 0) || now - (this.lastAttempt.get(pool) ?? 0) < (force ? 10_000 : 60_000))) return cached;
    this.lastAttempt.set(pool, now);
    const task = this.fetchPool(pool).finally(() => this.pending.delete(pool));
    this.pending.set(pool, task);
    return task;
  }

  private async fetchPool(pool: string): Promise<PoolPnl> {
    let retryAt = Date.now() + 60_000;
    try {
      const positions = new Map<string, PositionPnl>();
      for (let page = 1; ; page++) {
        const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/positions/${new PublicKey(pool).toBase58()}/pnl`);
        url.search = new URLSearchParams({ user: this.wallet, status: "open", page: String(page), page_size: "100" }).toString();
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const deadline = /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
          if (Number.isFinite(deadline)) retryAt = Math.max(retryAt, deadline);
        }
        if (!response.ok) throw new Error(`Meteora PnL HTTP ${response.status}`);
        const body = await readJsonResponse<any>(response);
        if (!body || !Array.isArray(body.positions) || typeof body.hasNext !== "boolean" || body.page !== page) {
          throw new Error("Respons PnL Meteora tidak valid");
        }
        for (const row of body.positions) {
          if (!row || typeof row.positionAddress !== "string" || row.isClosed !== false) throw new Error("Posisi PnL Meteora tidak valid");
          const id = new PublicKey(row.positionAddress).toBase58();
          if (positions.has(id)) throw new Error("Duplikat posisi pada halaman PnL Meteora");
          positions.set(id, {
            id, deposits: amount(row.allTimeDeposits?.total?.sol), withdrawals: amount(row.allTimeWithdrawals?.total?.sol),
            claimed: amount(row.allTimeFees?.total?.sol), pnl: amount(row.pnlSol), percent: amount(row.pnlSolPctChange),
            updatedAt: timestamp(row.updatedAt),
          });
        }
        if (!body.hasNext) break;
        if (!body.positions.length || page >= 1000) throw new Error("Pagination PnL Meteora tidak valid");
      }
      const result = { positions, fetchedAt: Date.now() };
      this.cache.set(pool, result);
      this.nextAttempt.delete(pool);
      return result;
    } catch (error) {
      const result = { ...this.cache.get(pool), positions: this.cache.get(pool)?.positions ?? new Map<string, PositionPnl>(), error: safeError(error) };
      this.cache.set(pool, result);
      this.nextAttempt.set(pool, Math.max(retryAt, Date.now() + 60_000));
      return result;
    }
  }
}
