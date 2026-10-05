import DLMM from "../meteora.ts";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Position } from "../domain/types.ts";
import type { DatabaseSync } from "node:sqlite";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function discoverPositions(connection: Connection, wallet: PublicKey, db: DatabaseSync, now = Date.now()): Promise<Position[]> {
  const grouped = await DLMM.getAllLbPairPositionsByUser(connection, wallet, { cluster: "mainnet-beta" });
  const discovered: Position[] = [];
  for (const [pool, info] of grouped) {
    const tokenX = info.tokenX.mint.address.toBase58();
    const tokenY = info.tokenY.mint.address.toBase58();
    const binStep = info.lbPair.binStep;
    const baseFeePercent = Number(DLMM.calculateFeeInfo(
      info.lbPair.parameters.baseFactor,
      binStep,
      info.lbPair.parameters.baseFeePowerFactor,
    ).baseFeeRatePercentage.toString());
    const solIsX = tokenX === SOL_MINT;
    const solIsY = tokenY === SOL_MINT;
    const tokenMint = solIsX ? tokenY : tokenX;
    const quoteMint = solIsX ? tokenX : solIsY ? tokenY : tokenY;
    for (const position of info.lbPairPositionsData) {
      const id = position.publicKey.toBase58();
      const lowerBinId = position.positionData.lowerBinId;
      const upperBinId = position.positionData.upperBinId;
      const previous = db.prepare("SELECT first_seen_at, ignored, active_bin FROM positions WHERE id=?").get(id) as { first_seen_at: number; ignored: number; active_bin: number | null } | undefined;
      const result: Position = {
        id, pool, tokenMint, quoteMint, binStep, baseFeePercent, lowerBinId, upperBinId,
        firstSeenAt: previous?.first_seen_at ?? now,
        ignored: Boolean(previous?.ignored), state: "OPEN",
        ...(previous?.active_bin == null ? {} : { activeBin: previous.active_bin }),
      };
      discovered.push(result);
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const upsert = db.prepare(`INSERT INTO positions
      (id,pool,token_mint,quote_mint,bin_step,base_fee_percent,lower_bin_id,upper_bin_id,first_seen_at,state,last_checked)
      VALUES(?,?,?,?,?,?,?,?,?,'OPEN',?)
      ON CONFLICT(id) DO UPDATE SET pool=excluded.pool, token_mint=excluded.token_mint,
      quote_mint=excluded.quote_mint, bin_step=excluded.bin_step, base_fee_percent=excluded.base_fee_percent,
      lower_bin_id=excluded.lower_bin_id,
      upper_bin_id=excluded.upper_bin_id, state='OPEN', last_checked=excluded.last_checked, closed_at=NULL`);
    for (const position of discovered) {
      upsert.run(position.id, position.pool, position.tokenMint, position.quoteMint, position.binStep, position.baseFeePercent,
        position.lowerBinId, position.upperBinId, position.firstSeenAt, now);
    }
    db.prepare("UPDATE positions SET state='CLOSED',closed_at=?,last_checked=? WHERE state='OPEN' AND id NOT IN (SELECT value FROM json_each(?))")
      .run(now, now, JSON.stringify(discovered.map((position) => position.id)));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return discovered;
}

export function listPositions(db: DatabaseSync, openOnly = true): Position[] {
  const rows = db.prepare(`SELECT id,pool,token_mint,quote_mint,bin_step,base_fee_percent,lower_bin_id,upper_bin_id,first_seen_at,ignored,state,active_bin
    FROM positions ${openOnly ? "WHERE state='OPEN'" : ""} ORDER BY first_seen_at`).all() as Array<Record<string, any>>;
  return rows.map((row) => ({
    id: row.id, pool: row.pool, tokenMint: row.token_mint, quoteMint: row.quote_mint,
    ...(row.bin_step == null ? {} : { binStep: row.bin_step }),
    ...(row.base_fee_percent == null ? {} : { baseFeePercent: row.base_fee_percent }),
    lowerBinId: row.lower_bin_id, upperBinId: row.upper_bin_id, firstSeenAt: row.first_seen_at,
    ignored: Boolean(row.ignored), state: row.state, ...(row.active_bin == null ? {} : { activeBin: row.active_bin }),
  }));
}

export function setPositionIgnored(db: DatabaseSync, id: string, ignored: boolean, at = Date.now()): boolean {
  return db.prepare("UPDATE positions SET ignored=?,ignore_updated_at=? WHERE id=? AND state='OPEN'")
    .run(ignored ? 1 : 0, at, id).changes > 0;
}
