export type Timeframe = "5m" | "15m" | "30m" | "1h";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  provider: string;
  unit: "usd" | "sol";
};

export type Position = {
  id: string;
  pool: string;
  tokenMint: string;
  quoteMint: string;
  binStep?: number;
  baseFeePercent?: number;
  lowerBinId: number;
  upperBinId: number;
  firstSeenAt: number;
  ignored: boolean;
  state: "OPEN" | "CLOSED";
  activeBin?: number;
};

export type TriggerReason = "INDICATOR" | "OOR_BELOW" | "OOR_ABOVE";

export type Trigger = {
  positionId: string;
  pool: string;
  reason: TriggerReason;
  detectedAt: number;
  confirmedAt: number;
  detail: Record<string, unknown>;
};
