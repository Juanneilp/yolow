import type { Position, Trigger } from "../domain/types.ts";

type SideConfig = { enabled: boolean; trigger_bins: number; confirm_sec: number };
type Pending = { side: "below" | "above"; since: number; lastDetail: Record<string, number> };

export class OorExitEngine {
  private readonly pending = new Map<string, Pending>();
  private readonly fired = new Map<string, "below" | "above">();
  private readonly retryAt = new Map<string, number>();

  update(position: Position, activeBin: number, now: number, below: SideConfig, above: SideConfig): Trigger | undefined {
    if (position.ignored || position.state !== "OPEN") {
      this.pending.delete(position.id);
      this.fired.delete(position.id);
      this.retryAt.delete(position.id);
      return undefined;
    }
    const belowDistance = position.lowerBinId - activeBin;
    const aboveDistance = activeBin - position.upperBinId;
    const side = below.enabled && belowDistance >= below.trigger_bins ? "below"
      : above.enabled && aboveDistance >= above.trigger_bins ? "above" : undefined;
    const config = side === "below" ? below : above;
    if (!side || !config) {
      this.pending.delete(position.id);
      this.fired.delete(position.id);
      this.retryAt.delete(position.id);
      return undefined;
    }
    const retryAt = this.retryAt.get(position.id);
    if (retryAt !== undefined && now < retryAt) return undefined;
    this.retryAt.delete(position.id);
    if (this.fired.get(position.id) === side) return undefined;
    const current = this.pending.get(position.id);
    if (!current || current.side !== side) {
      this.pending.set(position.id, { side, since: now, lastDetail: { activeBin, belowDistance, aboveDistance } });
      if (config.confirm_sec !== 0) return undefined;
      this.fired.set(position.id, side);
      this.pending.delete(position.id);
      return this.makeTrigger(position, side, now, now, { activeBin, belowDistance, aboveDistance });
    }
    current.lastDetail = { activeBin, belowDistance, aboveDistance };
    if (now - current.since < config.confirm_sec * 1000) return undefined;
    this.pending.delete(position.id);
    this.fired.set(position.id, side);
    return this.makeTrigger(position, side, current.since, now, current.lastDetail);
  }

  reset(positionId: string): void {
    this.pending.delete(positionId);
    this.fired.delete(positionId);
    this.retryAt.delete(positionId);
  }

  retain(positionIds: Set<string>): void {
    for (const positionId of this.pending.keys()) if (!positionIds.has(positionId)) this.pending.delete(positionId);
    for (const positionId of this.fired.keys()) if (!positionIds.has(positionId)) this.fired.delete(positionId);
    for (const positionId of this.retryAt.keys()) if (!positionIds.has(positionId)) this.retryAt.delete(positionId);
  }

  retry(positionId: string, at: number): void {
    this.pending.delete(positionId);
    this.fired.delete(positionId);
    this.retryAt.set(positionId, at);
  }

  private makeTrigger(position: Position, side: "below" | "above", detectedAt: number, confirmedAt: number, detail: Record<string, number>): Trigger {
    return {
      positionId: position.id,
      pool: position.pool,
      reason: side === "below" ? "OOR_BELOW" : "OOR_ABOVE",
      detectedAt,
      confirmedAt,
      detail: { ...detail, confirmMs: confirmedAt - detectedAt },
    };
  }
}
