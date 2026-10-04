import DLMM from "../meteora.ts";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Position } from "../domain/types.ts";
import type { DatabaseSync } from "node:sqlite";
import { OorExitEngine } from "../triggers/oor-exit.ts";
import { listPositions } from "../positions/monitor.ts";
import { safeError } from "../security.ts";

type Options = {
  connection: Connection;
  db: DatabaseSync;
  fallbackPollMs: number;
  below: { enabled: boolean; trigger_bins: number; confirm_sec: number };
  above: { enabled: boolean; trigger_bins: number; confirm_sec: number };
  poolOverrides: Record<string, {
    oor_exit?: {
      below?: Partial<{ enabled: boolean; trigger_bins: number; confirm_sec: number }>;
      above?: Partial<{ enabled: boolean; trigger_bins: number; confirm_sec: number }>;
    };
  }>;
  onTrigger: (trigger: { positionId: string; pool: string; reason: "OOR_BELOW" | "OOR_ABOVE"; detectedAt: number; confirmedAt: number; detail: Record<string, unknown> }) => Promise<number>;
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
  private readonly engine = new OorExitEngine();
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
    const activePools = new Set(positions.map((position) => position.pool));
    for (const [address, state] of this.pools) {
      if (activePools.has(address)) continue;
      if (state.subscription !== undefined) await this.options.connection.removeAccountChangeListener(state.subscription).catch(() => undefined);
      this.pools.delete(address);
    }
    for (const address of activePools) {
      const existing = this.pools.get(address);
      if (existing) {
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
              const decoded = client.program.coder.accounts.decode("lbPair", account.data) as { activeId: unknown };
              const activeBin = Number(decoded.activeId);
              if (!Number.isSafeInteger(activeBin)) throw new Error("activeId is not a safe integer");
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
      const positions = listPositions(this.options.db);
      this.engine.retain(new Set(positions.map((position) => position.id)));
      for (const [address, state] of this.pools) {
        const wsConnected = (this.options.connection as unknown as { _rpcWebSocketConnected?: boolean })._rpcWebSocketConnected;
        const feedStale = now - state.lastUpdate >= this.options.fallbackPollMs;
        const needsFallback = state.subscription === undefined || wsConnected !== true || feedStale;
        if (needsFallback && now - state.lastPollAt >= this.options.fallbackPollMs) {
          const pollStartedAt = Date.now();
          state.lastPollAt = pollStartedAt;
          try {
            const activeBin = (await state.client.getActiveBin()).binId;
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
          for (const position of positions.filter((item) => item.pool === address)) this.engine.reset(position.id);
          continue;
        }
        if (state.activeBin !== state.storedBin || now - state.storedAt >= 60_000) {
          await this.updateStoredBins(address, state.activeBin);
          state.storedBin = state.activeBin;
          state.storedAt = now;
        }
        for (const position of positions.filter((item) => item.pool === address)) {
          const overrides = this.options.poolOverrides[address]?.oor_exit;
          const below = { ...this.options.below, ...overrides?.below };
          const above = { ...this.options.above, ...overrides?.above };
          const trigger = this.engine.update(position, state.activeBin, now, below, above);
          if (trigger) {
            const retryAfterMs = await this.options.onTrigger(trigger);
            if (retryAfterMs > 0) this.engine.retry(position.id, Date.now() + retryAfterMs);
          }
        }
      }
    } finally { this.ticking = false; }
  }

  private async updateStoredBins(pool: string, activeBin: number): Promise<void> {
    this.options.db.prepare("UPDATE positions SET active_bin=?,last_checked=? WHERE pool=? AND state='OPEN'")
      .run(activeBin, Date.now(), pool);
  }
}

export function distance(position: Position, activeBin: number): { below: number; above: number } {
  return { below: position.lowerBinId - activeBin, above: activeBin - position.upperBinId };
}
