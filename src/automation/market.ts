import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { ExtensionType, getExtensionTypes } from "@solana/spl-token";
import DLMM from "../meteora.ts";
import type { AppConfig } from "../config/config.ts";
import type { Position } from "../domain/types.ts";
import { SOL_MINT } from "../positions/monitor.ts";
import { getJson } from "../market-data/top-careless.ts";
import { spotRange, fresh } from "./rules.ts";

export type Bin = { id: number; x: string; y: string; supply: string; price: string; feeX: string; feeY: string };
export type Snapshot = { at: number; active: number; step: number; solIsX: boolean; mint: string; bins: Bin[] };
export type Holding = { sol: bigint; token: bigint; rent?: bigint };
export type PaperBin = { id: number; shares: string; x: string; y: string; price: string; feeX: string; feeY: string };
export type EntryPlan = { snapshot: Snapshot; lower: number; upper: number; rent: bigint; gas: bigint; model: PaperBin[] };
export type Quote = { sol: bigint; valueMicrousd: bigint; gas: bigint; at: number };
export type Market = {
  snapshot(pool: string, lower: number, upper: number): Promise<Snapshot>;
  entry(pool: string, amount: bigint): Promise<EntryPlan>;
  holding(position: Position): Promise<Holding>;
  quote(mint: string, amount: bigint): Promise<Quote>;
  walletToken(mint: string): Promise<bigint>;
  walletSol(): Promise<bigint>;
  gas(binCount: number): bigint;
};
const SCALE = 1n << 64n;

export function paperModel(bins: Bin[], allocations: Array<{ binId: number; amountX: BN; amountY: BN }>): PaperBin[] {
  return allocations.filter((item) => !item.amountX.isZero() || !item.amountY.isZero()).map((item) => {
    const bin = bins.find((value) => value.id === item.binId);
    if (!bin) throw new Error("Bin entry belum tersedia");
    const x = BigInt(item.amountX.toString()), y = BigInt(item.amountY.toString());
    const price = BigInt(bin.price);
    const liquidity = x * price + y * SCALE;
    const existing = BigInt(bin.x) * price + BigInt(bin.y) * SCALE;
    if (BigInt(bin.supply) > 0n && existing <= 0n) throw new Error("Likuiditas bin tidak valid");
    const shares = BigInt(bin.supply) === 0n ? liquidity : liquidity * BigInt(bin.supply) / existing;
    return { id: bin.id, shares: shares.toString(), x: x.toString(), y: y.toString(), price: bin.price, feeX: bin.feeX, feeY: bin.feeY };
  });
}

export function markPaper(model: PaperBin[], snapshot: Snapshot): Holding {
  if (!fresh(snapshot.at)) throw new Error("Snapshot simulasi kedaluwarsa");
  let x = 0n, y = 0n;
  for (const item of model) {
    const bin = snapshot.bins.find((value) => value.id === item.id);
    if (!bin) throw new Error("Data bin simulasi tidak lengkap");
    const shares = BigInt(item.shares), supply = BigInt(bin.supply);
    if (supply > 0n) {
      x += shares * BigInt(bin.x) / supply;
      y += shares * BigInt(bin.y) / supply;
    } else {
      // shortcut: empty bins use ideal fills at the bin price; live fills require an on-chain position.
      const value = BigInt(item.x) * BigInt(item.price) + BigInt(item.y) * SCALE;
      if (snapshot.active === item.id) { x += BigInt(item.x); y += BigInt(item.y); }
      else if (snapshot.active < item.id) x += value / BigInt(item.price);
      else y += value / SCALE;
    }
    const feeX = BigInt(bin.feeX) - BigInt(item.feeX), feeY = BigInt(bin.feeY) - BigInt(item.feeY);
    if (feeX < 0n || feeY < 0n) throw new Error("Accumulator fee berubah; estimasi perlu ditinjau");
    x += (shares >> 64n) * feeX / SCALE;
    y += (shares >> 64n) * feeY / SCALE;
  }
  return snapshot.solIsX ? { sol: x, token: y } : { sol: y, token: x };
}

export class AutomationMarket implements Market {
  private readonly clients = new Map<string, { client: any; at: number }>();
  private nextJupiterAt = 0;
  private readonly decimals = new Map<string, number>();
  private readonly prices = new Map<string, { price: bigint; at: number }>();
  constructor(private readonly connection: Connection, private readonly wallet: PublicKey, private readonly config: AppConfig, private readonly apiKey?: string) {}

  gas(binCount: number): bigint {
    const transactions = Math.max(1, Math.ceil(binCount / 26)) + 2;
    const priority = Math.min(this.config.execution.priority_fee.microlamports, this.config.execution.priority_fee.max_cap_microlamports);
    return BigInt(transactions) * (10_000n + BigInt(Math.ceil(1_200_000 * priority / 1e6)));
  }

  private async client(pool: string): Promise<any> {
    let cached = this.clients.get(pool);
    if (!cached) {
      const client = await DLMM.create(this.connection, new PublicKey(pool), { cluster: "mainnet-beta" });
      this.decimals.set(client.tokenX.mint.address.toBase58(), client.tokenX.mint.decimals);
      this.decimals.set(client.tokenY.mint.address.toBase58(), client.tokenY.mint.decimals);
      cached = { client, at: Date.now() }; this.clients.set(pool, cached);
      if (this.clients.size > 100) this.clients.delete(this.clients.keys().next().value!);
    } else if (Date.now() - cached.at > 10_000) {
      await cached.client.refetchStates(); cached.at = Date.now();
    }
    return cached.client;
  }

  async snapshot(pool: string, lower: number, upper: number): Promise<Snapshot> {
    const client = await this.client(pool);
    const solIsX = client.tokenX.mint.address.toBase58() === SOL_MINT;
    if (!solIsX && client.tokenY.mint.address.toBase58() !== SOL_MINT) throw new Error("Pool bukan TOKEN/SOL");
    const data = await client.getBinsBetweenLowerAndUpperBound(lower, upper);
    const bins: Bin[] = data.bins.map((bin: any) => ({ id: bin.binId, x: bin.xAmount.toString(), y: bin.yAmount.toString(),
      supply: bin.supply.toString(), price: DLMM.getQPriceFromId(new BN(bin.binId), new BN(client.lbPair.binStep)).toString(),
      feeX: bin.feeAmountXPerTokenStored.toString(), feeY: bin.feeAmountYPerTokenStored.toString() }));
    if (bins.length !== upper - lower + 1) throw new Error("Cakupan bin tidak lengkap");
    return { at: Date.now(), active: data.activeBin, step: client.lbPair.binStep, solIsX,
      mint: (solIsX ? client.tokenY : client.tokenX).mint.address.toBase58(), bins };
  }

  async entry(pool: string, amount: bigint): Promise<EntryPlan> {
    const client = await this.client(pool);
    const step = client.lbPair.binStep, active = client.lbPair.activeId;
    const solIsX = client.tokenX.mint.address.toBase58() === SOL_MINT;
    if (!solIsX && client.tokenY.mint.address.toBase58() !== SOL_MINT) throw new Error("Pool bukan TOKEN/SOL");
    if (step < this.config.automation.min_bin_step) throw new Error("Bin step terlalu kecil");
    const { lower, upper } = spotRange(active, step, solIsX, this.config.automation.min_price_percent);
    const strategy = { minBinId: lower, maxBinId: upper, strategyType: DLMM.StrategyType.Spot, singleSidedX: solIsX };
    const cost = await client.quoteCreatePosition({ strategy });
    if (cost.positionCount !== 1 || ![cost.binArrayCost, cost.bitmapExtensionCost, cost.positionCost, cost.positionReallocCost].every(Number.isFinite) ||
        cost.binArrayCost !== 0 || cost.binArraysCount !== 0 || cost.bitmapExtensionCost !== 0) throw new Error("Biaya non-refundable atau biaya pembukaan belum pasti nol");
    const tokenMint = (solIsX ? client.tokenY : client.tokenX).mint;
    if (!Buffer.isBuffer(tokenMint.tlvData) || getExtensionTypes(tokenMint.tlvData).some((type) =>
      type !== ExtensionType.MetadataPointer && type !== ExtensionType.TokenMetadata)) throw new Error("Biaya ekstensi token belum dapat dipastikan nol");
    const snapshot = await this.snapshot(pool, lower, upper);
    if (snapshot.active !== active) throw new Error("Harga berubah saat pemeriksaan entry; coba siklus berikutnya");
    const zero = new BN(0), input = new BN(amount.toString());
    const activeBin = snapshot.bins.find((bin) => bin.id === active)!;
    const allocations = DLMM.toAmountsBothSideByStrategy(active, step, lower, upper, solIsX ? input : zero, solIsX ? zero : input,
      new BN(activeBin.x), new BN(activeBin.y), DLMM.StrategyType.Spot, client.tokenX.mint, client.tokenY.mint, client.clock);
    for (const allocation of allocations) {
      if (!(solIsX ? allocation.amountY : allocation.amountX).isZero()) throw new Error("Entry harus SOL saja");
      if (allocation.binId === active && !(solIsX ? allocation.amountX : allocation.amountY).isZero() &&
          BigInt(solIsX ? activeBin.y : activeBin.x) > 0n) throw new Error("Composition fee pembukaan belum dapat dipastikan nol");
    }
    const deposited = allocations.reduce((sum: bigint, item: any) => sum + BigInt((solIsX ? item.amountX : item.amountY).toString()), 0n);
    if (deposited > amount || amount - deposited > BigInt(upper - lower + 1)) throw new Error("Jumlah distribusi SPOT tidak sesuai deposit");
    const rent = await DLMM.getPositionRentExemption(this.connection, new BN(upper - lower + 1));
    if (!Number.isSafeInteger(rent) || rent < 0) throw new Error("Quote rent tidak valid");
    return { snapshot, lower, upper, rent: BigInt(rent), gas: this.gas(upper - lower + 1), model: paperModel(snapshot.bins, allocations) };
  }

  async holding(position: Position): Promise<Holding> {
    const client = await this.client(position.pool);
    const { positionData: data } = await client.getPosition(new PublicKey(position.id));
    if (!data.owner.equals(this.wallet)) throw new Error("Owner posisi tidak sesuai wallet");
    const x = BigInt(data.totalXAmountExcludeTransferFee.toString()) + BigInt(data.feeXExcludeTransferFee.toString());
    const y = BigInt(data.totalYAmountExcludeTransferFee.toString()) + BigInt(data.feeYExcludeTransferFee.toString());
    const account = await this.connection.getAccountInfo(new PublicKey(position.id), "confirmed");
    if (!account || !Number.isSafeInteger(account.lamports) || account.lamports < 0) throw new Error("Rent posisi belum tersedia");
    const rent = BigInt(account.lamports);
    return client.tokenX.mint.address.toBase58() === SOL_MINT ? { sol: x, token: y, rent } : { sol: y, token: x, rent };
  }

  async walletSol(): Promise<bigint> {
    const balance = await this.connection.getBalance(this.wallet, "confirmed");
    if (!Number.isSafeInteger(balance) || balance < 0) throw new Error("Saldo SOL wallet tidak valid");
    return BigInt(balance);
  }

  async walletToken(mint: string): Promise<bigint> {
    const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet, { mint: new PublicKey(mint) }, "confirmed");
    return accounts.value.reduce((sum, { account }) => {
      const info = (account.data as any).parsed?.info;
      if (info?.owner !== this.wallet.toBase58() || info?.mint !== mint || typeof info?.tokenAmount?.amount !== "string" || !/^\d{1,40}$/.test(info.tokenAmount.amount)) throw new Error("Saldo token wallet tidak valid");
      return sum + BigInt(info.tokenAmount.amount);
    }, 0n);
  }

  private async json(url: URL): Promise<any> {
    if (!this.apiKey) throw new Error("JUPITER_API_KEY dibutuhkan");
    const delay = Math.max(0, this.nextJupiterAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.nextJupiterAt = Date.now() + 1100;
    return getJson(url, { "x-api-key": this.apiKey });
  }

  async quote(mint: string, amount: bigint): Promise<Quote> {
    if (amount < 0n) throw new Error("Jumlah quote negatif");
    const missing = [SOL_MINT, mint].filter((key) => !this.prices.has(key) || Date.now() - this.prices.get(key)!.at > 60_000);
    if (missing.length) {
      const priceUrl = new URL(this.config.jupiter.price_base_url ?? "https://api.jup.ag/price/v3");
      priceUrl.searchParams.set("ids", [...new Set(missing)].join(","));
      const prices = await this.json(priceUrl);
      for (const key of missing) {
        const usd = prices[key]?.usdPrice ?? prices.data?.[key]?.usdPrice;
        const scaled = Math.round(usd * 1e12);
        if (typeof usd === "number" && Number.isSafeInteger(scaled) && scaled > 0) this.prices.set(key, { price: BigInt(scaled), at: Date.now() });
      }
    }
    const solPrice = this.prices.get(SOL_MINT);
    if (!solPrice || Date.now() - solPrice.at > 60_000) throw new Error("SOL/USD belum tersedia");
    const tokenPrice = this.prices.get(mint), decimals = this.decimals.get(mint);
    if (mint !== SOL_MINT && tokenPrice && Date.now() - tokenPrice.at <= 60_000 && decimals !== undefined) {
      const valueMicrousd = amount * tokenPrice.price / (10n ** BigInt(decimals) * 1_000_000n);
      if (valueMicrousd < BigInt(Math.ceil(this.config.swap.min_value_usd * 1e6))) return { sol: 0n, valueMicrousd, gas: 0n, at: Date.now() };
    }
    let sol = amount;
    if (mint !== SOL_MINT && amount > 0n) {
      const url = new URL(this.config.jupiter.base_url.replace(/\/$/, "") + "/build");
      url.search = new URLSearchParams({ inputMint: mint, outputMint: SOL_MINT, amount: amount.toString(),
        slippageBps: String(this.config.swap.slippage_bps), taker: this.wallet.toBase58(), wrapAndUnwrapSol: "true" }).toString();
      const build = await this.json(url);
      if (build.inputMint !== mint || build.outputMint !== SOL_MINT || build.inAmount !== amount.toString() || build.swapMode !== "ExactIn" ||
          build.slippageBps !== this.config.swap.slippage_bps || !/^\d{1,40}$/.test(build.outAmount) || !/^\d{1,40}$/.test(build.otherAmountThreshold) ||
          BigInt(build.otherAmountThreshold) <= 0n || BigInt(build.otherAmountThreshold) > BigInt(build.outAmount)) throw new Error("Quote Jupiter tidak sesuai permintaan");
      sol = BigInt(build.otherAmountThreshold);
    }
    return { sol, valueMicrousd: sol * solPrice.price / 1_000_000_000_000_000n, gas: mint !== SOL_MINT && amount > 0n ? this.gas(1) : 0n, at: Date.now() };
  }
}
