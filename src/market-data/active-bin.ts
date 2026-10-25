import DLMM from "../meteora.ts";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { DatabaseSync } from "node:sqlite";
import { listPositions } from "../positions/monitor.ts";
import { safeError } from "../security.ts";

type Options = {
  connection: Connection;
  db: DatabaseSync;
  fallbackPollMs: number;
  extraPools?: () => string[];

};

type ActivePool = {
  client: DLMM;
  activeBin: number;
  lastUpdate: number;
  lastPollAt: number;
  storedBin: number;
  storedAt: number;
  subscription?: number;
};

export class ActiveBinMonitor {
  private readonly pools = new Map<string, ActivePool>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private ticking = false;

  constructor(private readonly options: Options) {}

  async start(): Promise<void> {
    await this.refreshPools();
    this.timer = setInterval(() => void this.tick().catch((error) => console.error("OOR monitor tick failed:", safeError(error))), 250);
  }

  async refreshPools(): Promise<void> {
    const positions = listPositions(this.options.db);
    const activePools = new Set([...positions.map((position) => position.pool), ...(this.options.extraPools?.() ?? [])]);
    for (const [address, state] of this.pools) {
      if (activePools.has(address)) continue;
      if (state.subscription !== undefined) await this.options.connection.removeAccountChangeListener(state.subscription).catch(() => undefined);
      this.pools.delete(address);
    }
    for (const address of activePools) {
      const existing = this.pools.get(address);
      if (existing) {
        if (Date.now() - existing.lastUpdate > this.options.fallbackPollMs * 2) continue;
        await this.updateStoredBins(address, existing.activeBin);
        existing.storedBin = existing.activeBin;
        existing.storedAt = Date.now();
        continue;
      }
      try {
        const poolKey = new PublicKey(address);
        const client = await DLMM.create(this.options.connection, poolKey, { cluster: "mainnet-beta" });
        const activeBin = (await client.getActiveBin()).binId;
        const now = Date.now();
        const state: ActivePool = { client, activeBin, lastUpdate: now, lastPollAt: 0, storedBin: activeBin, storedAt: now };
        this.pools.set(address, state);
        try {
          state.subscription = this.options.connection.onAccountChange(poolKey, (account) => {
            try {
              const activeBin = decodeActiveBin(client, account.data);
              state.activeBin = activeBin;
              state.lastUpdate = Date.now();
            } catch (error) {
              console.warn(`Could not decode active bin for ${address}:`, safeError(error));
            }
          }, "processed");
        } catch (error) {
          console.warn(`Active-bin subscription failed for ${address}; polling will be used:`, safeError(error));
        }
        await this.updateStoredBins(address, activeBin);
      } catch (error) {
        this.pools.delete(address);
        console.warn(`Could not initialize active-bin feed for ${address}; it will retry during position discovery:`, safeError(error));
      }
    }
  }

  latest(pool: string): { active: number; step: number; solIsX: boolean; at: number } | undefined {
    const state = this.pools.get(pool);
    if (!state || Date.now() - state.lastUpdate > this.options.fallbackPollMs * 2) return undefined;
    return { active: state.activeBin, step: state.client.lbPair.binStep,
      solIsX: state.client.tokenX.mint.address.toBase58() === "So11111111111111111111111111111111111111112", at: state.lastUpdate };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const state of this.pools.values()) {
      if (state.subscription !== undefined) await this.options.connection.removeAccountChangeListener(state.subscription).catch(() => undefined);
    }
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 25));
    this.pools.clear();
  }

  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      let now = Date.now();
      for (const [address, state] of this.pools) {
        const wsConnected = (this.options.connection as unknown as { _rpcWebSocketConnected?: boolean })._rpcWebSocketConnected;
        const feedStale = now - state.lastUpdate >= this.options.fallbackPollMs;
        const needsFallback = state.subscription === undefined || wsConnected !== true || feedStale;
        if (needsFallback && now - state.lastPollAt >= this.options.fallbackPollMs) {
          const pollStartedAt = Date.now();
          state.lastPollAt = pollStartedAt;
          try {
            const account = await this.options.connection.getAccountInfo(new PublicKey(address), "confirmed");
            if (!account) throw new Error("Pool account unavailable");
            const activeBin = decodeActiveBin(state.client, account.data);
            if (state.lastUpdate < pollStartedAt) {
              state.activeBin = activeBin;
              state.lastUpdate = Date.now();
            }
          } catch (error) {
            console.warn(`Active-bin fallback failed for ${address}:`, safeError(error));
          }
        }
        now = Date.now();
        if (needsFallback && now - state.lastUpdate > this.options.fallbackPollMs * 2) {
          continue;
        }
        if (state.activeBin !== state.storedBin || now - state.storedAt >= 60_000) {
          await this.updateStoredBins(address, state.activeBin);
          state.storedBin = state.activeBin;
          state.storedAt = now;
        }

      }
    } finally { this.ticking = false; }
  }

  private async updateStoredBins(pool: string, activeBin: number): Promise<void> {
    this.options.db.prepare("UPDATE positions SET active_bin=?,last_checked=? WHERE pool=? AND state='OPEN'")
      .run(activeBin, Date.now(), pool);
  }
}

function decodeActiveBin(client: DLMM, data: Buffer): number {
  const decoded = client.program.coder.accounts.decode("lbPair", data) as { activeId: unknown };
  const activeBin = Number(decoded.activeId);
  if (!Number.isSafeInteger(activeBin)) throw new Error("activeId is not a safe integer");
  return activeBin;
}
