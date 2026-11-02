import { createProgram } from "../meteora.ts";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { DatabaseSync } from "node:sqlite";
import { listPositions, SOL_MINT } from "../positions/monitor.ts";
import { safeError } from "../security.ts";

type Options = {
  connection: Connection;
  db: DatabaseSync;
  fallbackPollMs: number;
  extraPools?: () => string[];
};
type Price = { active: number; step: number; solIsX: boolean; at: number };
type ActivePool = { price?: Price };

export class ActiveBinMonitor {
  private readonly pools = new Map<string, ActivePool>();
  private readonly program;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private polling?: Promise<void>;
  private lastPollAt?: number;

  constructor(private readonly options: Options) {
    this.program = createProgram(options.connection, { cluster: "mainnet-beta" });
  }

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll().catch((error) => console.error("OOR monitor tick failed:", safeError(error))), 250);
  }

  async refreshPools(): Promise<void> {
    const active = new Set([...listPositions(this.options.db).map((position) => position.pool), ...(this.options.extraPools?.() ?? [])]);
    for (const address of this.pools.keys()) if (!active.has(address)) this.pools.delete(address);
    for (const address of active) if (!this.pools.has(address)) this.pools.set(address, {});
  }

  latest(pool: string): Price | undefined {
    const price = this.pools.get(pool)?.price;
    return price && Date.now() - price.at <= this.options.fallbackPollMs * 2 ? { ...price } : undefined;
  }

  poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = this.readPools().finally(() => { this.polling = undefined; });
    return this.polling;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling;
    this.pools.clear();
  }

  private async readPools(): Promise<void> {
    await this.refreshPools();
    const now = Date.now();
    if (!this.pools.size || (this.lastPollAt !== undefined && now - this.lastPollAt < this.options.fallbackPollMs)) return;
    this.lastPollAt = now;
    const due = [...this.pools];
    for (let offset = 0; offset < due.length && !this.closed; offset += 100) {
      const batch = due.slice(offset, offset + 100);
      const at = Date.now();
      try {
        const accounts = await this.options.connection.getMultipleAccountsInfo(batch.map(([address]) => new PublicKey(address)), "confirmed");
        if (this.closed) return;
        for (const [index, [address, state]] of batch.entries()) {
          if (this.pools.get(address) !== state) continue;
          try {
            const account = accounts[index];
            if (!account || !account.owner.equals(this.program.programId)) throw new Error("Pool account unavailable or owner invalid");
            const decoded = this.program.coder.accounts.decode("lbPair", account.data);
            const active = Number(decoded.activeId), step = Number(decoded.binStep);
            if (!Number.isSafeInteger(active) || !Number.isSafeInteger(step) || step < 1) throw new Error("Invalid active bin or bin step");
            state.price = { active, step, solIsX: decoded.tokenXMint.toBase58() === SOL_MINT, at };
            this.options.db.prepare("UPDATE positions SET active_bin=?,last_checked=? WHERE pool=? AND state='OPEN'")
              .run(active, at, address);
          } catch (error) {
            console.warn(`Could not decode active bin for ${address}:`, safeError(error));
          }
        }
      } catch (error) {
        console.warn("Active-bin batch failed:", safeError(error));
      }
    }
  }
}
