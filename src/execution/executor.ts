import DLMM from "../meteora.ts";
import BN from "bn.js";
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Keypair, PublicKey,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  type Connection, type Transaction,
} from "@solana/web3.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AppConfig } from "../config/config.ts";
import type { Position, Trigger } from "../domain/types.ts";
import type { DatabaseSync } from "node:sqlite";
import { getMeta, setMeta } from "../storage/db.ts";
import { discoverPositions, listPositions } from "../positions/monitor.ts";
import { persistTradeCsv } from "../journal/export.ts";
import { join } from "node:path";
import { readJsonResponse, safeError } from "../security.ts";
import { notificationCard, triggerReasonLabel } from "../telegram/presentation.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_SWAP_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

class SkipClose extends Error {
  constructor(message: string, readonly outcome: string) { super(message); }
}

class UnknownBroadcast extends Error {}

export function formatExitTimestamp(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).format(new Date(epoch));
}

type Options = {
  connection: Connection;
  db: DatabaseSync;
  config: AppConfig;
  wallet: PublicKey;
  jupiterApiKey?: string;
  notify: (message: string) => Promise<void>;
  keypairPath?: string;
  keypair?: Keypair;
};

type JupiterInstruction = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
};

type JupiterBuild = {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  swapMode?: string;
  priceImpact?: number;
  priceImpactPct?: string;
  error?: string;
  errorMessage?: string;
  setupInstructions?: JupiterInstruction[];
  swapInstruction?: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction | null;
  otherInstructions?: JupiterInstruction[];
  tipInstruction?: JupiterInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]> | null;
  blockhashWithMetadata?: { blockhash: number[]; lastValidBlockHeight: number };
};

function toJupiterInstruction(instruction: JupiterInstruction, wallet: PublicKey, allowedPrograms: Set<string>): TransactionInstruction {
  if (!instruction || typeof instruction.programId !== "string" || !Array.isArray(instruction.accounts) ||
      instruction.accounts.length > 256 || typeof instruction.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(instruction.data)) {
    throw new Error("Jupiter mengembalikan instruksi dengan format tidak valid");
  }
  if (!allowedPrograms.has(instruction.programId)) throw new Error("Jupiter mengembalikan program swap yang tidak diizinkan");
  for (const account of instruction.accounts) {
    if (typeof account?.pubkey !== "string" || typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") {
      throw new Error("Jupiter mengembalikan account meta dengan format tidak valid");
    }
    if (account.isSigner && account.pubkey !== wallet.toBase58()) throw new Error("Jupiter meminta signer selain wallet agent");
  }
  if (Buffer.from(instruction.data, "base64").byteLength > 1232) throw new Error("Data instruksi Jupiter melebihi batas transaksi");
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
}

export function jupiterTransactionInstructions(build: JupiterBuild, wallet: PublicKey): TransactionInstruction[] {
  const setup = build.setupInstructions ?? [];
  if (!Array.isArray(setup) || setup.length > 8 || (build.otherInstructions?.length ?? 0) !== 0 || build.tipInstruction) {
    throw new Error("Jupiter mengembalikan instruksi tambahan yang tidak diizinkan");
  }
  const instructions = setup.map((instruction) => {
    const result = toJupiterInstruction(instruction, wallet, new Set([ASSOCIATED_TOKEN_PROGRAM_ID]));
    if (result.keys.length < 6 || !result.keys[0].pubkey.equals(wallet) || !result.keys[0].isSigner ||
        !result.keys[2].pubkey.equals(wallet)) throw new Error("Jupiter setup harus membuat ATA milik wallet agent");
    return result;
  });
  instructions.push(toJupiterInstruction(build.swapInstruction!, wallet, new Set([JUPITER_SWAP_PROGRAM_ID])));
  if (build.cleanupInstruction) {
    const cleanup = toJupiterInstruction(build.cleanupInstruction, wallet, TOKEN_PROGRAM_IDS);
    if (cleanup.keys.length < 3 || !cleanup.keys[1].pubkey.equals(wallet) || !cleanup.keys[2].pubkey.equals(wallet) || !cleanup.keys[2].isSigner) {
      throw new Error("Jupiter cleanup harus mengembalikan akun token ke wallet agent");
    }
    instructions.push(cleanup);
  }
  if (instructions.length > 10) throw new Error("Jupiter mengembalikan terlalu banyak instruksi");
  return instructions;
}

export async function loadSigner(path: string, wallet: PublicKey): Promise<Keypair> {
  const resolvedPath = await realpath(resolve(path));
  const relativePath = relative(await realpath(process.cwd()), resolvedPath);
  if (relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) {
    throw new Error("AGENT_KEYPAIR_PATH harus berada di luar repository");
  }
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile() || fileStat.size > 4_096) throw new Error("File keypair harus berupa file kecil yang valid");
  if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) throw new Error("File keypair harus dimiliki user yang menjalankan Yolow");
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) throw new Error("Izin file keypair terlalu terbuka; gunakan chmod 600");
  const secret = JSON.parse(await readFile(resolvedPath, "utf8"));
  if (!Array.isArray(secret) || secret.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("File keypair harus berupa array byte Solana");
  const signer = Keypair.fromSecretKey(new Uint8Array(secret));
  if (!signer.publicKey.equals(wallet)) throw new Error("Public key keypair tidak cocok dengan AGENT_WALLET_PUBKEY");
  return signer;
}

export class CloseExecutor {
  private readonly inFlight = new Set<string>();
  private readonly swapsInFlight = new Set<string>();
  private signer?: Keypair;

  constructor(private readonly options: Options) { this.signer = options.keypair; }

  setSigner(signer: Keypair): void { this.signer = signer; }

  isDryRun(): boolean {
    const stored = getMeta(this.options.db, "dry_run");
    return stored === undefined ? this.options.config.mode.dry_run : stored !== "false";
  }

  async reconcileTransactions(): Promise<void> {
    const unresolved = this.options.db.prepare("SELECT signature,kind FROM transactions WHERE status IN ('PENDING','UNKNOWN')")
      .all() as Array<{ signature: string; kind: string }>;
    for (const transaction of unresolved) {
      const status = await this.options.connection.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true }).catch(() => null);
      const chain = status?.value[0];
      if (chain && (chain.confirmationStatus === "confirmed" || chain.confirmationStatus === "finalized") && chain.err === null) {
        this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=COALESCE(confirmed_at,?) WHERE signature=?")
          .run(Date.now(), transaction.signature);
      } else if (chain?.err) {
        this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=COALESCE(confirmed_at,?) WHERE signature=?")
          .run(JSON.stringify(chain.err), Date.now(), transaction.signature);
      } else {
        this.options.db.prepare("UPDATE transactions SET status='UNKNOWN' WHERE signature=?").run(transaction.signature);
      }
    }

    const swaps = this.options.db.prepare(`SELECT t.signature,t.position_id FROM transactions t
      WHERE t.kind='SWAP' AND t.status='CONFIRMED'`).all() as Array<{ signature: string; position_id: string }>;
    for (const swap of swaps) await this.reconcileSwap(swap.signature, swap.position_id);

    await discoverPositions(this.options.connection, this.options.wallet, this.options.db);
    const closed = listPositions(this.options.db, false).filter((position) => position.state === "CLOSED");
    for (const position of closed) await this.reconcileClose(position);
  }

  private async reconcileSwap(signature: string, positionId: string): Promise<void> {
    const trade = this.options.db.prepare("SELECT swap_signature,swap_status FROM trade_history WHERE position_id=?")
      .get(positionId) as { swap_signature: string | null; swap_status: string | null } | undefined;
    if (trade?.swap_signature === signature && trade.swap_status === "CONFIRMED") return;
    const swap = this.options.db.prepare("SELECT * FROM swaps WHERE signature=?").get(signature) as Record<string, any> | undefined;
    const deltas = await this.transactionDeltas(signature, SOL_MINT);
    const actualSol = deltas.solDelta > 0n ? Number(deltas.solDelta) / 1e9 : null;
    this.options.db.prepare("UPDATE swaps SET status='CONFIRMED',sol_received_lamports=?,updated_at=? WHERE signature=?")
      .run(deltas.solDelta > 0n ? deltas.solDelta.toString() : null, Date.now(), signature);
    this.options.db.prepare(`UPDATE trade_history SET swap_status='CONFIRMED',swap_signature=?,swap_input_mint=COALESCE(?,swap_input_mint),
      swap_sol_received=?,total_sol_returned=COALESCE(sol_received,0)+COALESCE(?,0),finalized_at=? WHERE position_id=?`)
      .run(signature, swap?.input_mint ?? null, actualSol, actualSol, Date.now(), positionId);
    if (trade?.swap_signature !== signature) {
      this.options.db.prepare("UPDATE trade_history SET network_fees_sol=COALESCE(network_fees_sol,0)+? WHERE position_id=?")
        .run(Number(deltas.feeLamports) / 1e9, positionId);
    }
    this.updatePnl(positionId);
  }

  private async reconcileClose(position: Position): Promise<void> {
    const trade = this.options.db.prepare("SELECT * FROM trade_history WHERE position_id=?")
      .get(position.id) as Record<string, any> | undefined;
    if (!trade || trade.finalized_at !== null) return;
    const unsettled = this.options.db.prepare("SELECT 1 AS present FROM transactions WHERE position_id=? AND kind='CLOSE' AND status IN ('PENDING','UNKNOWN') LIMIT 1")
      .get(position.id);
    if (unsettled) return;
    let result = this.options.db.prepare("SELECT * FROM close_results WHERE position_id=? AND status='CONFIRMED' ORDER BY created_at DESC LIMIT 1")
      .get(position.id) as Record<string, any> | undefined;
    if (!result) {
      const txs = this.options.db.prepare(`SELECT signature,confirmed_at FROM transactions
        WHERE position_id=? AND kind='CLOSE' AND status='CONFIRMED' ORDER BY confirmed_at`).all(position.id) as Array<{ signature: string; confirmed_at: number | null }>;
      if (!txs.length) return;
      let token = 0n;
      let solAmount = 0n;
      let fees = 0n;
      for (const tx of txs) {
        const delta = await this.transactionDeltas(tx.signature, position.tokenMint);
        token += delta.tokenDelta;
        solAmount += delta.solDelta;
        fees += delta.feeLamports;
      }
      const trigger = this.recoveredTrigger(trade.trade_id, txs.at(-1)!.signature);
      const triggerRow = this.options.db.prepare("SELECT id FROM triggers WHERE position_id=? ORDER BY id DESC LIMIT 1")
        .get(position.id) as { id: number } | undefined;
      const signature = txs.at(-1)!.signature;
      this.options.db.prepare(`INSERT INTO close_results(position_id,trigger_id,token_mint,token_received,sol_received_lamports,signature,mode,status,created_at)
        VALUES(?,?,?,?,?,?,'live','CONFIRMED',?)`).run(position.id, triggerRow?.id ?? null, position.tokenMint,
        token.toString(), solAmount.toString(), signature, Date.now());
      const closedAt = txs.at(-1)!.confirmed_at ?? Date.now();
      const metrics = this.positionMetrics(position.id, closedAt);
      this.options.db.prepare(`UPDATE trade_history SET exit_at=?,trigger_reason=?,trigger_detail=?,close_signature=?,sol_received=?,tokens_received=?,
        network_fees_sol=?,duration_sec=?,time_in_range_pct=?,mfe_sol=?,mae_sol=?,max_drawdown_pct=?,max_active_bin=?,min_active_bin=?,range_exit_count=?,
        total_sol_returned=?,finalized_at=NULL WHERE position_id=?`)
        .run(closedAt, trigger?.reason ?? "INDICATOR", trigger ? JSON.stringify(trigger.detail) : "{}", signature,
          Number(solAmount) / 1e9, token.toString(), Number(fees) / 1e9, metrics.duration, metrics.inRangePct,
          metrics.mfe, metrics.mae, metrics.maxDrawdown, metrics.maxActiveBin, metrics.minActiveBin,
          metrics.rangeExits, Number(solAmount) / 1e9, position.id);
      result = { position_id: position.id, token_received: token.toString(), sol_received_lamports: solAmount.toString(), signature };
    }
    setMeta(this.options.db, "close_failures", "0");
    setMeta(this.options.db, "close_failures_at", "0");
    if (trade.exit_at == null) {
      const trigger = this.recoveredTrigger(trade.trade_id, result.signature);
      const closedAt = Number(result.created_at ?? Date.now());
      const solAmount = Number(BigInt(result.sol_received_lamports ?? "0")) / 1e9;
      const tokenAmount = BigInt(result.token_received ?? "0");
      const metrics = this.positionMetrics(position.id, closedAt);
      const detail = trigger ? JSON.stringify(trigger.detail) : "{}";
      const exitPrice = trigger?.reason === "INDICATOR" && trigger.detail.unit === "usd" && typeof trigger.detail.close === "number"
        ? trigger.detail.close : null;
      this.options.db.prepare(`UPDATE trade_history SET exit_at=?,trigger_reason=?,trigger_detail=?,close_signature=?,sol_received=?,tokens_received=?,
        exit_price_usd=?,network_fees_sol=COALESCE(network_fees_sol,0),duration_sec=?,time_in_range_pct=?,mfe_sol=?,mae_sol=?,max_drawdown_pct=?,
        max_active_bin=?,min_active_bin=?,range_exit_count=?,total_sol_returned=? WHERE position_id=?`)
        .run(closedAt, trigger?.reason ?? "INDICATOR", detail, result.signature, solAmount, tokenAmount.toString(), exitPrice,
          metrics.duration, metrics.inRangePct, metrics.mfe, metrics.mae, metrics.maxDrawdown, metrics.maxActiveBin,
          metrics.minActiveBin, metrics.rangeExits, solAmount, position.id);
      const tradeId = trade.trade_id as number;
      const offsets = this.options.config.history.post_exit_marks_min as number[];
      const priceAvailable = exitPrice !== null;
      const saveMark = this.options.db.prepare(`INSERT OR IGNORE INTO post_exit_marks(trade_id,offset_min,due_at,status,reason)
        VALUES(?,?,?, ?,?)`);
      for (const offset of offsets) saveMark.run(tradeId, offset, closedAt + offset * 60_000,
        priceAvailable ? "PENDING" : "UNAVAILABLE", priceAvailable ? null : "exit price in USD unavailable");
      this.updatePnl(position.id);
    }
    const tokens = BigInt(result.token_received ?? 0);
    if (!this.options.config.swap.enabled || tokens <= 0n) {
      this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
        .run(this.options.config.swap.enabled ? "SKIPPED_NO_TOKEN" : "SKIPPED_DISABLED", Date.now(), position.id);
      this.updatePnl(position.id);
    } else {
      const previousSwap = this.options.db.prepare("SELECT status FROM swaps WHERE position_id=? ORDER BY id DESC LIMIT 1")
        .get(position.id) as { status: string } | undefined;
      if (previousSwap && ["PENDING", "UNKNOWN"].includes(previousSwap.status)) return;
      if (!previousSwap) await this.finishSwap(position, tokens, false, result.signature ?? undefined);
      else {
        this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
          .run(previousSwap.status, Date.now(), position.id);
        this.updatePnl(position.id);
      }
    }
    await this.exportCsv();
    await this.options.notify(notificationCard("🔄 JOURNAL POSISI DIPULIHKAN", [
      `Posisi ${position.id}`,
      "Yolow menemukan transaksi close terkonfirmasi di blockchain dan memulihkan catatan trade.",
      `Signature https://solscan.io/tx/${result.signature}`,
    ]));
  }

  private recoveredTrigger(tradeId: number, signature: string): Trigger | undefined {
    const rows = this.options.db.prepare("SELECT payload FROM trade_events WHERE trade_id=? AND type IN ('CLOSE_SENT','CLOSE_PREPARED') ORDER BY at DESC")
      .all(tradeId) as Array<{ payload: string }>;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as { signature?: string; trigger?: Trigger };
        if (payload.signature === signature && payload.trigger) return payload.trigger;
      } catch { /* ignore malformed historical event */ }
    }
    const fallback = this.options.db.prepare(`SELECT pool,reason,detected_at,confirmed_at,detail FROM triggers
      WHERE position_id=(SELECT position_id FROM trade_history WHERE trade_id=?) ORDER BY id DESC LIMIT 1`)
      .get(tradeId) as { pool: string; reason: Trigger["reason"]; detected_at: number; confirmed_at: number; detail: string } | undefined;
    if (!fallback) return undefined;
    return { positionId: (this.options.db.prepare("SELECT position_id FROM trade_history WHERE trade_id=?").get(tradeId) as { position_id: string }).position_id,
      pool: fallback.pool, reason: fallback.reason, detectedAt: fallback.detected_at, confirmedAt: fallback.confirmed_at, detail: JSON.parse(fallback.detail) };
  }

  async retrySwap(positionId: string): Promise<void> {
    if (this.swapsInFlight.has(positionId)) throw new Error("Swap untuk posisi ini sedang berjalan.");
    const failed = this.options.db.prepare(`SELECT input_amount,close_signature FROM swaps
      WHERE position_id=? AND status IN ('NO_ROUTE','FAILED') ORDER BY id DESC LIMIT 1`)
      .get(positionId) as { input_amount: string; close_signature: string | null } | undefined;
    if (!failed) throw new Error("Tidak ada swap NO_ROUTE/FAILED untuk posisi ini.");
    if (!this.options.config.swap.enabled) throw new Error("swap.enabled sedang nonaktif.");
    if (!this.isDryRun() && !this.signer) throw new Error("Live mode memerlukan signer yang valid.");
    const position = listPositions(this.options.db, false).find((item) => item.id === positionId);
    if (!position) throw new Error("Posisi tidak ditemukan di journal.");
    const accounts = await this.options.connection.getParsedTokenAccountsByOwner(this.options.wallet, { mint: new PublicKey(position.tokenMint) }, "confirmed");
    const balance = accounts.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
    const amount = balance < BigInt(failed.input_amount) ? balance : BigInt(failed.input_amount);
    if (amount <= 0n) throw new Error("Tidak ada token dari close tersebut yang tersisa di wallet.");
    if (this.swapsInFlight.has(positionId)) throw new Error("Swap untuk posisi ini sedang berjalan.");
    await this.finishSwap(position, amount, this.isDryRun(), failed.close_signature ?? undefined);
  }

  async execute(trigger: Trigger): Promise<number> {
    if (this.inFlight.has(trigger.positionId)) return 60_000;
    this.inFlight.add(trigger.positionId);
    try { return await this.closePosition(trigger); }
    catch (error) {
      const reason = safeError(error);
      if (error instanceof SkipClose) {
        this.markTrigger(trigger, error.outcome);
        await this.options.notify(notificationCard("ℹ️ CLOSE DILEWATI", [
          `Posisi ${trigger.positionId}`,
          `Alasan ${triggerReasonLabel(trigger.reason)}`,
          `🕒 Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
          reason,
        ]));
        return 0;
      }
      const failures = Number(getMeta(this.options.db, "close_failures") ?? 0) + 1;
      setMeta(this.options.db, "close_failures", String(failures));
      setMeta(this.options.db, "close_failures_at", String(Date.now()));
      this.markTrigger(trigger, "FAILED");
      console.error("Close pipeline failed:", reason);
      await this.options.notify(notificationCard(
        failures >= 3 ? "🚨 CLOSE DIJEDA SEMENTARA" : "🔴 CLOSE GAGAL",
        [
          `Posisi ${trigger.positionId}`,
          `Alasan ${triggerReasonLabel(trigger.reason)}`,
          `Percobaan gagal ${failures}/3`,
          `Detail ${reason}`,
          failures >= 3
            ? "Tindakan: close dijeda 10 menit, lalu Yolow mencoba lagi otomatis."
            : "Tindakan: Yolow mencoba kembali otomatis.",
          `🕒 Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
        ],
      ));
      return failures >= 3 ? 600_000 : 60_000;
    } finally { this.inFlight.delete(trigger.positionId); }
  }

  private async closePosition(trigger: Trigger): Promise<number> {
    const position = listPositions(this.options.db).find((item) => item.id === trigger.positionId);
    if (!position) { this.markTrigger(trigger, "POSITION_CLOSED"); return 0; }
    if (position.ignored) { this.markTrigger(trigger, "IGNORED"); return 0; }
    const trade = this.options.db.prepare("SELECT finalized_at FROM trade_history WHERE position_id=?").get(position.id) as { finalized_at: number | null } | undefined;
    if (trade?.finalized_at) { this.markTrigger(trigger, "ALREADY_FINALIZED"); return 0; }
    const unresolved = this.options.db.prepare("SELECT signature FROM transactions WHERE position_id=? AND kind='CLOSE' AND status IN ('PENDING','UNKNOWN') LIMIT 1")
      .get(position.id) as { signature: string } | undefined;
    if (unresolved) { this.markTrigger(trigger, "CLOSE_PENDING"); return 300_000; }
    let failures = Number(getMeta(this.options.db, "close_failures") ?? 0);
    const failureAt = Number(getMeta(this.options.db, "close_failures_at") ?? 0);
    if (failures >= 3 && failureAt > 0 && Date.now() - failureAt >= 600_000) {
      failures = 0;
      setMeta(this.options.db, "close_failures", "0");
      setMeta(this.options.db, "close_failures_at", "0");
      await this.options.notify(notificationCard("✅ PEMANTAUAN CLOSE DILANJUTKAN", [
        "Jeda setelah kegagalan berakhir. Yolow kembali memproses sinyal exit.",
        `🕒 ${formatExitTimestamp(Date.now(), this.options.config.timezone)}`,
      ]));
    }
    if (failures >= 3) {
      this.markTrigger(trigger, "CIRCUIT_BREAKER");
      return Math.max(1, 600_000 - (Date.now() - failureAt));
    }
    if (trigger.reason !== "INDICATOR" && !(await this.recheckOor(position, trigger))) {
      this.markTrigger(trigger, "OOR_RESET");
      return 0;
    }
    let pool = await DLMM.create(this.options.connection, new PublicKey(position.pool), { cluster: "mainnet-beta" });
    let currentPosition = await pool.getPosition(new PublicKey(position.id));
    if (!currentPosition.positionData.owner.equals(this.options.wallet)) throw new Error("Posisi tidak dimiliki wallet agent");
    const dryRun = this.isDryRun();
    await this.options.notify(notificationCard(
      dryRun ? "🟡 SIMULASI CLOSE DIMULAI" : "🔴 CLOSE DIMULAI",
      [
        `Posisi ${position.id}`,
        `Pool ${position.pool}`,
        `Alasan ${triggerReasonLabel(trigger.reason)}`,
        `🕒 Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
      ],
    ));
    let sent: string[] = [];
    let tokenReceived = 0n;
    let solReceivedLamports = 0n;
    let feesLamports = 0n;
    let lastFailure: unknown;
    const maxAttempts = dryRun ? 1 : Math.max(1, this.options.config.execution.max_retries);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        if (attempt > 0) {
          pool = await DLMM.create(this.options.connection, new PublicKey(position.pool), { cluster: "mainnet-beta" });
          currentPosition = await pool.getPosition(new PublicKey(position.id));
          if (!currentPosition.positionData.owner.equals(this.options.wallet)) throw new Error("Posisi tidak dimiliki wallet agent");
        }
        const txs = await pool.removeLiquidity({
          user: this.options.wallet, position: new PublicKey(position.id),
          fromBinId: position.lowerBinId, toBinId: position.upperBinId,
          bps: new BN(10_000), shouldClaimAndClose: true,
        });
        if (txs.length === 0) throw new Error("SDK tidak membentuk transaksi close");
        for (const tx of txs) {
          if (!this.isStillEligible(position.id)) throw new SkipClose("Posisi di-ignore atau tidak lagi terbuka sebelum transaksi", "IGNORED");
          await this.addPriorityFee(tx);
          const result = await this.submit(tx, position, trigger, dryRun);
          if (result.signature) sent.push(result.signature);
          tokenReceived += result.tokenDelta ?? 0n;
          solReceivedLamports += result.solDelta ?? 0n;
          feesLamports += result.feeLamports ?? 0n;
        }
        lastFailure = undefined;
        break;
      } catch (error) {
        if (error instanceof UnknownBroadcast || error instanceof SkipClose || dryRun || attempt + 1 >= maxAttempts) throw error;
        lastFailure = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (lastFailure) throw lastFailure;
    if (dryRun) {
      tokenReceived = this.estimateTokenAmount(pool, currentPosition, position);
      solReceivedLamports = this.estimateSolAmount(pool, currentPosition, position);
    }
    this.markTrigger(trigger, dryRun ? "DRY_RUN" : "EXECUTED");
    if (!dryRun) this.options.db.prepare("UPDATE positions SET state='CLOSED',closed_at=?,last_checked=? WHERE id=?")
      .run(Date.now(), Date.now(), position.id);
    this.options.db.prepare(`INSERT INTO close_results(position_id,trigger_id,token_mint,signature,mode,status,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(position.id, this.triggerId(trigger), position.tokenMint, sent.at(-1) ?? null,
      dryRun ? "dry_run" : "live", dryRun ? "DRY_RUN" : "CONFIRMED", Date.now());
    this.options.db.prepare("UPDATE close_results SET token_received=?,sol_received_lamports=? WHERE position_id=? AND created_at=(SELECT max(created_at) FROM close_results WHERE position_id=?)")
      .run(tokenReceived.toString(), solReceivedLamports.toString(), position.id, position.id);
    const closedAt = Date.now();
    const closeSol = Number(solReceivedLamports) / 1e9;
    const metrics = this.positionMetrics(position.id, closedAt);
    const networkFees = Number(feesLamports) / 1e9;
    this.options.db.prepare(`UPDATE trade_history SET exit_at=?,trigger_reason=?,trigger_detail=?,close_signature=?,sol_received=?,tokens_received=?,
      exit_price_usd=?,exit_active_bin=?,network_fees_sol=?,duration_sec=?,time_in_range_pct=?,mfe_sol=?,mae_sol=?,max_drawdown_pct=?,
      max_active_bin=?,min_active_bin=?,range_exit_count=?,total_sol_returned=?,pnl_reason=CASE WHEN initial_sol_capital IS NULL THEN 'initial capital unavailable' ELSE 'estimated from first-seen snapshot' END,
      finalized_at=? WHERE position_id=?`)
      .run(closedAt, trigger.reason, JSON.stringify(trigger.detail), sent.at(-1) ?? null, closeSol, tokenReceived.toString(),
        trigger.reason === "INDICATOR" && trigger.detail.unit === "usd" && typeof trigger.detail.close === "number" ? trigger.detail.close : null,
        typeof trigger.detail.activeBin === "number" ? trigger.detail.activeBin : position.activeBin ?? null,
        networkFees, metrics.duration, metrics.inRangePct, metrics.mfe, metrics.mae, metrics.maxDrawdown,
        metrics.maxActiveBin, metrics.minActiveBin, metrics.rangeExits, closeSol,
        dryRun || !this.options.config.swap.enabled ? closedAt : null, position.id);
    this.updatePnl(position.id);
    const tradeId = (this.options.db.prepare("SELECT trade_id FROM trade_history WHERE position_id=?").get(position.id) as { trade_id: number } | undefined)?.trade_id;
    if (tradeId !== undefined) {
      const timeframe = this.options.config.pool_overrides[position.pool]?.indicator_exit?.timeframe
        ?? getMeta(this.options.db, "active_timeframe") ?? this.options.config.indicator_exit.timeframe;
      const unit = trigger.detail.unit === "sol" || trigger.detail.unit === "usd" ? trigger.detail.unit : this.options.config.candles.price_unit;
      const latestProvider = this.options.db.prepare(`SELECT provider FROM candles
        WHERE asset_key=? AND timeframe=? AND unit=? ORDER BY open_time DESC LIMIT 1`).get(position.pool, timeframe, unit) as { provider: string } | undefined;
      const provider = typeof trigger.detail.provider === "string" ? trigger.detail.provider : latestProvider?.provider;
      const context = this.options.db.prepare(`SELECT c.provider,c.open_time,c.timeframe,c.unit,c.open,c.high,c.low,c.close,c.volume,
        s.rsi,s.bb_upper,s.macd_hist FROM candles c LEFT JOIN signals s ON s.asset_key=c.asset_key AND s.provider=c.provider
          AND s.timeframe=c.timeframe AND s.unit=c.unit AND s.candle_time=c.open_time
        WHERE c.asset_key=? AND c.timeframe=? AND c.unit=? AND c.provider=? ORDER BY c.open_time DESC LIMIT ?`)
        .all(position.pool, timeframe, unit, provider ?? "", this.options.config.history.context_candles) as Array<Record<string, any>>;
      const saveContext = this.options.db.prepare(`INSERT OR IGNORE INTO trade_candles
        (trade_id,candle_time,provider,timeframe,unit,open,high,low,close,volume,rsi,bb_upper,macd_hist) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const candle of context.reverse()) saveContext.run(tradeId, candle.open_time, candle.provider, candle.timeframe, candle.unit,
        candle.open, candle.high, candle.low, candle.close, candle.volume, candle.rsi, candle.bb_upper, candle.macd_hist);
      const priceAvailable = trigger.reason === "INDICATOR" && trigger.detail.unit === "usd" && typeof trigger.detail.close === "number";
      const marks = this.options.db.prepare(`INSERT OR IGNORE INTO post_exit_marks(trade_id,offset_min,due_at,status,reason)
        VALUES(?,?,?, ?,?)`);
      for (const offset of this.options.config.history.post_exit_marks_min as number[]) {
        marks.run(tradeId, offset, closedAt + offset * 60_000,
          priceAvailable ? "PENDING" : "UNAVAILABLE", priceAvailable ? null : "exit price in USD unavailable");
      }
    }
    this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_FINAL',? FROM trade_history WHERE position_id=?")
      .run(Date.now(), JSON.stringify({ mode: dryRun ? "dry_run" : "live", signatures: sent }), position.id);
    setMeta(this.options.db, "close_failures", "0");
    setMeta(this.options.db, "close_failures_at", "0");
    if (dryRun) {
      if (tokenReceived > 0n) await this.finishSwap(position, tokenReceived, true, sent.at(-1));
      else this.options.db.prepare("UPDATE trade_history SET swap_status='SKIPPED_NO_TOKEN',finalized_at=? WHERE position_id=?").run(Date.now(), position.id);
      await this.exportCsv();
      await this.options.notify(notificationCard("✅ SIMULASI CLOSE SELESAI", [
        `Posisi ${position.id}`,
        `Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
        `Simulasi selesai ${formatExitTimestamp(Date.now(), this.options.config.timezone)}`,
        "Tidak ada transaksi yang ditandatangani atau dikirim ke blockchain.",
      ]));
      return 0;
    }
    await this.options.notify(notificationCard("✅ CLOSE TERKONFIRMASI", [
      `Posisi ${position.id}`,
      `Sinyal exit ${formatExitTimestamp(trigger.confirmedAt, this.options.config.timezone)}`,
      `Close selesai ${formatExitTimestamp(Date.now(), this.options.config.timezone)}`,
      ...sent.map((signature) => `🔗 https://solscan.io/tx/${signature}`),
    ]));
    if (this.options.config.swap.enabled && tokenReceived > 0n) await this.finishSwap(position, tokenReceived, false, sent.at(-1));
    else {
      this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
        .run(this.options.config.swap.enabled ? "SKIPPED_NO_TOKEN" : "SKIPPED_DISABLED", Date.now(), position.id);
      if (this.options.config.swap.enabled) await this.options.notify(notificationCard("ℹ️ SWAP DILEWATI", [
        `Posisi ${position.id}`,
        `Token ${position.tokenMint}`,
        "Tidak ada token yang diterima dari close untuk ditukar ke SOL.",
      ]));
      await this.exportCsv();
    }
    return 0;
  }

  private async recheckOor(position: Position, trigger: Trigger): Promise<boolean> {
    if (position.ignored) return false;
    const pool = await DLMM.create(this.options.connection, new PublicKey(position.pool), { cluster: "mainnet-beta" });
    const activeBin = (await pool.getActiveBin()).binId;
    const side = trigger.reason === "OOR_BELOW" ? "below" : "above";
    const setting = { ...this.options.config.oor_exit[side], ...this.options.config.pool_overrides[position.pool]?.oor_exit?.[side] };
    if (!setting.enabled) return false;
    const distance = trigger.reason === "OOR_BELOW" ? position.lowerBinId - activeBin : activeBin - position.upperBinId;
    return distance >= setting.trigger_bins;
  }

  private async addPriorityFee(tx: Transaction): Promise<void> {
    const settings = this.options.config.execution.priority_fee;
    const configured = Number(settings.microlamports ?? 100_000);
    const cap = Number(settings.max_cap_microlamports ?? configured);
    const microLamports = Math.max(0, Math.min(configured, cap));
    tx.instructions = tx.instructions.filter((instruction) => {
      if (!instruction.programId.equals(ComputeBudgetProgram.programId)) return true;
      const discriminator = instruction.data[0];
      return discriminator !== 2 && discriminator !== 3;
    });
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    );
  }

  private async submit(tx: Transaction, position: Position, trigger: Trigger, dryRun: boolean): Promise<{ signature?: string; tokenDelta?: bigint; solDelta?: bigint; feeLamports?: bigint }> {
    const blockhash = await this.options.connection.getLatestBlockhash("confirmed");
    tx.feePayer = this.options.wallet;
    tx.recentBlockhash = blockhash.blockhash;
    if (dryRun) {
      const simulation = await this.options.connection.simulateTransaction(tx);
      if (simulation.value.err) throw new Error(`Simulasi gagal: ${JSON.stringify(simulation.value.err)}`);
      return {};
    }
    if (!this.signer) throw new Error("Live mode memerlukan AGENT_KEYPAIR_PATH yang valid");
    tx.sign(this.signer);
    const signatureBytes = tx.signature;
    if (!signatureBytes) throw new Error("Signature transaksi tidak terbentuk");
    const signature = bs58.encode(signatureBytes);
    const simulation = await this.options.connection.simulateTransaction(tx, { commitment: "confirmed" });
    if (simulation.value.err) throw new Error(`Simulasi gagal: ${JSON.stringify(simulation.value.err)}`);
    if (!this.isStillEligible(position.id)) throw new SkipClose("Posisi di-ignore sebelum broadcast", "IGNORED");
    this.options.db.prepare(`INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at)
      VALUES(?,'CLOSE',?,?, 'PENDING',?) ON CONFLICT(signature) DO NOTHING`)
      .run(signature, position.id, position.pool, Date.now());
    if (!this.isStillEligible(position.id)) {
      this.options.db.prepare("UPDATE transactions SET status='CANCELLED',error=?,confirmed_at=? WHERE signature=?")
        .run("Posisi di-ignore sebelum broadcast", Date.now(), signature);
      this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_CANCELLED',? FROM trade_history WHERE position_id=?")
        .run(Date.now(), JSON.stringify({ signature, trigger }), position.id);
      throw new SkipClose("Posisi di-ignore sebelum broadcast", "IGNORED");
    }
    this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_PREPARED',? FROM trade_history WHERE position_id=?")
      .run(Date.now(), JSON.stringify({ signature, trigger }), position.id);
    try {
      await this.options.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 0 });
      this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_BROADCAST',? FROM trade_history WHERE position_id=?")
        .run(Date.now(), JSON.stringify({ signature }), position.id);
      const result = await this.options.connection.confirmTransaction({ signature, ...blockhash }, "confirmed");
      if (result.value.err) {
        this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=? WHERE signature=?")
          .run(JSON.stringify(result.value.err), Date.now(), signature);
        throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
      }
      this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
      return { signature, ...await this.transactionDeltas(signature, position.tokenMint) };
    } catch (error) {
      const status = await this.options.connection.getSignatureStatuses([signature]).catch(() => null);
      const chainStatus = status?.value[0];
      if (chainStatus && (chainStatus.confirmationStatus === "confirmed" || chainStatus.confirmationStatus === "finalized") && chainStatus.err === null) {
        this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
        return { signature, ...await this.transactionDeltas(signature, position.tokenMint) };
      }
      if (chainStatus?.err) {
        this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=? WHERE signature=?")
          .run(JSON.stringify(chainStatus.err), Date.now(), signature);
        throw error;
      }
      const reason = safeError(error);
      this.options.db.prepare("UPDATE transactions SET status='UNKNOWN',error=? WHERE signature=?").run(reason, signature);
      this.options.db.prepare("INSERT INTO trade_events(trade_id,at,type,payload) SELECT trade_id,?,'CLOSE_UNKNOWN',? FROM trade_history WHERE position_id=?")
        .run(Date.now(), JSON.stringify({ signature, error: reason }), position.id);
      throw new UnknownBroadcast(`Transaksi ${signature} sudah disiapkan/dikirim tetapi status konfirmasi belum diketahui; tidak dikirim ulang otomatis`);
    }
  }

  private isStillEligible(id: string): boolean {
    const row = this.options.db.prepare("SELECT ignored,state FROM positions WHERE id=?").get(id) as { ignored: number; state: string } | undefined;
    return !!row && row.ignored === 0 && row.state === "OPEN";
  }

  private triggerId(trigger: Trigger): number | null {
    const row = this.options.db.prepare("SELECT id FROM triggers WHERE position_id=? AND reason=? AND confirmed_at=? ORDER BY id DESC LIMIT 1")
      .get(trigger.positionId, trigger.reason, trigger.confirmedAt) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private markTrigger(trigger: Trigger, outcome: string): void {
    this.options.db.prepare(`INSERT INTO triggers(position_id,pool,reason,detected_at,confirmed_at,detail,outcome)
      VALUES(?,?,?,?,?,?,?)`).run(trigger.positionId, trigger.pool, trigger.reason, trigger.detectedAt,
      trigger.confirmedAt, JSON.stringify(trigger.detail), outcome);
    this.options.db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload)
      SELECT trade_id,?,'TRIGGER_CONFIRMED',? FROM trade_history WHERE position_id=?`)
      .run(trigger.confirmedAt, JSON.stringify({ trigger, outcome }), trigger.positionId);
  }

  private estimateTokenAmount(pool: DLMM, positionData: any, position: Position): bigint {
    const mintIsX = pool.tokenX.mint.address.toBase58() === position.tokenMint;
    const value = mintIsX ? positionData.positionData.totalXAmountExcludeTransferFee : positionData.positionData.totalYAmountExcludeTransferFee;
    return BigInt(value.toString());
  }

  private estimateSolAmount(pool: DLMM, positionData: any, position: Position): bigint {
    const solIsX = pool.tokenX.mint.address.toBase58() === SOL_MINT;
    const solIsY = pool.tokenY.mint.address.toBase58() === SOL_MINT;
    const value = solIsX ? positionData.positionData.totalXAmountExcludeTransferFee
      : solIsY ? positionData.positionData.totalYAmountExcludeTransferFee : 0;
    return BigInt(value.toString());
  }

  private positionMetrics(positionId: string, closedAt: number): {
    duration: number; inRangePct: number | null; mfe: number | null; mae: number | null;
    maxDrawdown: number | null; maxActiveBin: number | null; minActiveBin: number | null; rangeExits: number;
  } {
    const trade = this.options.db.prepare("SELECT first_seen_at FROM trade_history WHERE position_id=?").get(positionId) as { first_seen_at: number } | undefined;
    const rows = this.options.db.prepare("SELECT active_bin,sol_value,in_range FROM position_snapshots WHERE position_id=? ORDER BY at")
      .all(positionId) as Array<{ active_bin: number; sol_value: number | null; in_range: number }>;
    let peak = 0;
    let maxDrawdown = 0;
    let rangeExits = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const value = rows[index].sol_value;
      if (value !== null) {
        peak = Math.max(peak, value);
        if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak * 100);
      }
      if (index > 0 && rows[index - 1].in_range === 1 && rows[index].in_range === 0) rangeExits += 1;
    }
    const values = rows.map((row) => row.sol_value).filter((value): value is number => value !== null);
    return {
      duration: trade ? Math.max(0, (closedAt - trade.first_seen_at) / 1000) : 0,
      inRangePct: rows.length ? rows.filter((row) => row.in_range === 1).length / rows.length * 100 : null,
      mfe: values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
      mae: values.length ? values.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null,
      maxDrawdown: values.length ? maxDrawdown : null,
      maxActiveBin: rows.length ? rows.reduce((maximum, row) => Math.max(maximum, row.active_bin), -Infinity) : null,
      minActiveBin: rows.length ? rows.reduce((minimum, row) => Math.min(minimum, row.active_bin), Infinity) : null,
      rangeExits,
    };
  }

  private updatePnl(positionId: string): void {
    const trade = this.options.db.prepare(`SELECT initial_sol_capital,total_sol_returned,network_fees_sol
      FROM trade_history WHERE position_id=?`).get(positionId) as { initial_sol_capital: number | null; total_sol_returned: number | null; network_fees_sol: number | null } | undefined;
    if (!trade || trade.initial_sol_capital === null || trade.total_sol_returned === null) return;
    const pnl = trade.total_sol_returned - trade.initial_sol_capital - (trade.network_fees_sol ?? 0);
    this.options.db.prepare(`UPDATE trade_history SET pnl_sol=?,pnl_pct=?,pnl_usd=NULL,
      pnl_reason='estimated from first-seen snapshot; USD conversion unavailable' WHERE position_id=?`)
      .run(pnl, trade.initial_sol_capital > 0 ? pnl / trade.initial_sol_capital * 100 : null, positionId);
  }

  private async transactionDeltas(signature: string, tokenMint: string): Promise<{ tokenDelta: bigint; solDelta: bigint; feeLamports: bigint }> {
    let tx: any = null;
    for (let attempt = 0; attempt < 5 && !tx; attempt += 1) {
      tx = await this.options.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const meta = tx?.meta;
    if (!meta) return { tokenDelta: 0n, solDelta: 0n, feeLamports: 0n };
    const tokenTotal = (balances: any[] | null | undefined) => (balances ?? []).filter((balance) => balance.mint === tokenMint && (!balance.owner || balance.owner === this.options.wallet.toBase58()))
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
    const tokenDelta = tokenTotal(meta.postTokenBalances) - tokenTotal(meta.preTokenBalances);
    const keys: any[] = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys ?? [];
    const walletIndex = keys.findIndex((key) => String(key) === this.options.wallet.toBase58());
    const solDelta = walletIndex < 0 ? 0n : BigInt(meta.postBalances[walletIndex] - meta.preBalances[walletIndex] + meta.fee);
    return { tokenDelta: tokenDelta > 0n ? tokenDelta : 0n, solDelta: solDelta > 0n ? solDelta : 0n, feeLamports: BigInt(meta.fee ?? 0) };
  }

  private async processSwap(position: Position, tokenAmount: bigint, dryRun: boolean, closeSignature?: string): Promise<void> {
    const now = Date.now();
    const saveSwap = (status: string, values: { out?: string; usd?: number; impact?: number; signature?: string; sol?: string; error?: string; slippage?: number } = {}) => {
      this.options.db.prepare(`INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,quoted_sol_lamports,estimated_usd,slippage_bps,price_impact,status,signature,sol_received_lamports,error,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(position.id, closeSignature ?? null, position.tokenMint, tokenAmount.toString(),
        values.out ?? null, values.usd ?? null, values.slippage ?? null, values.impact ?? null, status, values.signature ?? null,
        values.sol ?? null, values.error ?? null, now, Date.now());
    };
    if (!this.options.config.swap.enabled) {
      saveSwap("SKIPPED_DISABLED");
      this.options.db.prepare(`UPDATE trade_history SET swap_status='SKIPPED_DISABLED',
        total_sol_returned=COALESCE(sol_received,0),finalized_at=COALESCE(finalized_at,?) WHERE position_id=?`)
        .run(Date.now(), position.id);
      this.updatePnl(position.id);
      return;
    }
    if (!this.options.jupiterApiKey) { saveSwap("FAILED", { error: "JUPITER_API_KEY tidak tersedia" }); throw new Error("JUPITER_API_KEY diperlukan untuk swap"); }
    if (tokenAmount <= 0n) { saveSwap("SKIPPED_DUST"); return; }
    const base = this.options.config.jupiter.base_url.replace(/\/$/, "");
    const priceBase = this.options.config.jupiter.price_base_url ?? "https://api.jup.ag/price/v3";
    let solUsd = 0;
    try {
      const priceUrl = new URL(priceBase);
      priceUrl.searchParams.set("ids", SOL_MINT);
      const response = await fetch(priceUrl, { headers: { "x-api-key": this.options.jupiterApiKey }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const body = await readJsonResponse<Record<string, { usdPrice?: number }>>(response);
      solUsd = Number(body[SOL_MINT]?.usdPrice ?? body.data?.[SOL_MINT]?.usdPrice ?? 0);
      if (!response.ok || !Number.isFinite(solUsd) || solUsd <= 0) throw new Error("SOL/USD price tidak tersedia");
    } catch (error) { saveSwap("FAILED", { error: safeError(error) }); throw error; }

    let lastError = "no route";
    for (let attempt = 0; attempt < this.options.config.swap.max_retries; attempt += 1) {
      const slippage = Math.min(this.options.config.swap.slippage_bps + attempt * 250, this.options.config.swap.max_slippage_bps);
      const buildBase = base.replace(/\/swap\/v1\/?$/, "/swap/v2");
      const buildUrl = new URL(`${buildBase}/build`);
      buildUrl.searchParams.set("inputMint", position.tokenMint);
      buildUrl.searchParams.set("outputMint", SOL_MINT);
      buildUrl.searchParams.set("amount", tokenAmount.toString());
      buildUrl.searchParams.set("taker", this.options.wallet.toBase58());
      buildUrl.searchParams.set("slippageBps", String(slippage));
      buildUrl.searchParams.set("wrapAndUnwrapSol", "true");
      let buildResponse: Response;
      let build: JupiterBuild;
      try {
        buildResponse = await fetch(buildUrl, { headers: { "x-api-key": this.options.jupiterApiKey }, redirect: "error", signal: AbortSignal.timeout(20_000) });
        build = await readJsonResponse<JupiterBuild>(buildResponse);
      } catch (error) {
        lastError = safeError(error);
        continue;
      }
      if (!buildResponse.ok || !build.outAmount || !build.swapInstruction) {
        lastError = safeError(build.errorMessage ?? build.error ?? `Jupiter build HTTP ${buildResponse.status}`);
        continue;
      }
      if (build.inputMint !== position.tokenMint || build.outputMint !== SOL_MINT ||
          build.inAmount !== tokenAmount.toString() || build.swapMode !== "ExactIn" || build.slippageBps !== slippage ||
          typeof build.outAmount !== "string" || !/^\d{1,40}$/.test(build.outAmount) || BigInt(build.outAmount) <= 0n ||
          typeof build.otherAmountThreshold !== "string" || !/^\d{1,40}$/.test(build.otherAmountThreshold) ||
          BigInt(build.otherAmountThreshold) <= 0n || BigInt(build.otherAmountThreshold) > BigInt(build.outAmount)) {
        lastError = "Jupiter mengembalikan quote yang tidak cocok dengan input swap";
        continue;
      }
      const priceImpact = Number(build.priceImpact ?? (Number(build.priceImpactPct ?? 0) * 100));
      if (!Number.isFinite(priceImpact) || priceImpact < 0 || priceImpact > 100) {
        lastError = "Jupiter mengembalikan price impact yang tidak valid";
        continue;
      }
      const estimatedUsd = Number(build.outAmount) / 1_000_000_000 * solUsd;
      if (estimatedUsd < this.options.config.swap.min_value_usd) {
        saveSwap("SKIPPED_DUST", { out: build.outAmount, usd: estimatedUsd, impact: priceImpact, slippage });
        this.options.db.prepare("UPDATE trade_history SET swap_status='SKIPPED_DUST',remaining_dust_usd=?,finalized_at=? WHERE position_id=?")
          .run(estimatedUsd, Date.now(), position.id);
        this.updatePnl(position.id);
        await this.options.notify(notificationCard("🟡 SWAP DILEWATI · NILAI DUST", [
          `Posisi ${position.id}`,
          `Estimasi nilai $${estimatedUsd.toFixed(2)} · batas swap $${this.options.config.swap.min_value_usd.toFixed(2)}`,
          "Token tetap berada di wallet karena nilainya di bawah batas minimum swap.",
        ]));
        return;
      }
      if (dryRun) {
        saveSwap("DRY_RUN_QUOTED", { out: build.outAmount, usd: estimatedUsd, impact: priceImpact, slippage });
        this.options.db.prepare("UPDATE trade_history SET swap_status='DRY_RUN_QUOTED',swap_sol_received=?,total_sol_returned=COALESCE(sol_received,0)+?,finalized_at=? WHERE position_id=?")
          .run(Number(build.outAmount) / 1e9, Number(build.outAmount) / 1e9, Date.now(), position.id);
        this.updatePnl(position.id);
        await this.options.notify(notificationCard("🟡 SIMULASI SWAP", [
          `Posisi ${position.id}`,
          `Perkiraan diterima ${(Number(build.outAmount) / 1e9).toFixed(6)} SOL · sekitar $${estimatedUsd.toFixed(2)}`,
          `Dampak harga ${priceImpact.toFixed(2)}%`,
          "Mode DRY-RUN: quote diperiksa, transaksi tidak dikirim.",
        ]));
        return;
      }
      if (!this.signer) throw new Error("Live mode memerlukan signer yang valid");
      if (!build.blockhashWithMetadata || !Array.isArray(build.blockhashWithMetadata.blockhash) ||
          build.blockhashWithMetadata.blockhash.length !== 32 ||
          build.blockhashWithMetadata.blockhash.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
          !Number.isSafeInteger(build.blockhashWithMetadata.lastValidBlockHeight) || build.blockhashWithMetadata.lastValidBlockHeight < 1) {
        lastError = "Jupiter build tidak mengembalikan blockhash yang valid";
        continue;
      }
      let transaction: VersionedTransaction;
      let recentBlockhash: string;
      const lastValidBlockHeight = build.blockhashWithMetadata.lastValidBlockHeight;
      try {
        const configuredMicroLamports = Number(this.options.config.execution.priority_fee.microlamports);
        const capMicroLamports = Number(this.options.config.execution.priority_fee.max_cap_microlamports);
        const instructions = jupiterTransactionInstructions(build, this.options.wallet);
        const lookupAddresses = Object.keys(build.addressesByLookupTableAddress ?? {});
        if (lookupAddresses.length > 10) throw new Error("Jupiter mengembalikan terlalu banyak lookup table");
        const lookupTables = await Promise.all(lookupAddresses.map(async (address) => {
          const result = await this.options.connection.getAddressLookupTable(new PublicKey(address), { commitment: "confirmed" });
          if (!result.value) throw new Error(`Jupiter address lookup table ${address} tidak ditemukan`);
          return result.value;
        }));
        recentBlockhash = bs58.encode(Buffer.from(build.blockhashWithMetadata.blockhash));
        const makeTransaction = (computeUnits: number) => new VersionedTransaction(new TransactionMessage({
          payerKey: this.options.wallet,
          recentBlockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, Math.min(configuredMicroLamports, capMicroLamports)) }),
            ...instructions,
          ],
        }).compileToV0Message(lookupTables));
        const simulation = await this.options.connection.simulateTransaction(makeTransaction(1_400_000), {
          commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true,
        });
        if (simulation.value.err) throw new Error(`swap simulation ${JSON.stringify(simulation.value.err)}`);
        const computeUnits = Math.min(Math.ceil((simulation.value.unitsConsumed ?? 1_200_000) * 1.2), 1_400_000);
        transaction = makeTransaction(computeUnits);
        transaction.sign([this.signer]);
      } catch (error) {
        lastError = safeError(error);
        continue;
      }
      const signature = bs58.encode(transaction.signatures[0]);
      const txTime = Date.now();
      this.options.db.prepare(`INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at) VALUES(?,'SWAP',?,?,'PENDING',?)`)
        .run(signature, position.id, position.pool, txTime);
      saveSwap("PENDING", { out: build.outAmount, usd: estimatedUsd, impact: priceImpact, slippage, signature });
      this.options.db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload)
        SELECT trade_id,?,'SWAP_PREPARED',? FROM trade_history WHERE position_id=?`)
        .run(txTime, JSON.stringify({ signature, inputAmount: tokenAmount.toString(), quote: build.outAmount }), position.id);
      try {
        await this.options.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 0 });
        this.options.db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload)
          SELECT trade_id,?,'SWAP_BROADCAST',? FROM trade_history WHERE position_id=?`)
          .run(Date.now(), JSON.stringify({ signature }), position.id);
        const confirmed = await this.options.connection.confirmTransaction({
          signature, blockhash: recentBlockhash, lastValidBlockHeight,
        }, "confirmed");
        if (confirmed.value.err) throw new Error(JSON.stringify(confirmed.value.err));
      } catch (error) {
        const status = await this.options.connection.getSignatureStatuses([signature]).catch(() => null);
        const chainStatus = status?.value[0];
        if (chainStatus && (chainStatus.confirmationStatus === "confirmed" || chainStatus.confirmationStatus === "finalized") && chainStatus.err === null) {
          this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
        } else if (chainStatus?.err) {
          this.options.db.prepare("UPDATE transactions SET status='FAILED',error=?,confirmed_at=? WHERE signature=?")
            .run(JSON.stringify(chainStatus.err), Date.now(), signature);
          this.options.db.prepare("UPDATE swaps SET status='FAILED',error=?,updated_at=? WHERE signature=?")
            .run(JSON.stringify(chainStatus.err), Date.now(), signature);
          lastError = `swap transaction failed: ${JSON.stringify(chainStatus.err)}`;
          continue;
        } else {
          const reason = safeError(error);
          this.options.db.prepare("UPDATE transactions SET status='UNKNOWN',error=? WHERE signature=?").run(reason, signature);
          this.options.db.prepare("UPDATE swaps SET status='UNKNOWN',error=?,updated_at=? WHERE signature=?")
            .run("Status konfirmasi belum diketahui; tidak dikirim ulang otomatis", Date.now(), signature);
          throw new UnknownBroadcast(`Swap ${signature} sudah dikirim tetapi status belum diketahui; retry otomatis dihentikan`);
        }
      }
      const deltas = await this.transactionDeltas(signature, SOL_MINT);
      this.options.db.prepare("UPDATE transactions SET status='CONFIRMED',confirmed_at=? WHERE signature=?").run(Date.now(), signature);
      this.options.db.prepare("UPDATE swaps SET status='CONFIRMED',sol_received_lamports=?,updated_at=? WHERE signature=?")
        .run(deltas.solDelta > 0n ? deltas.solDelta.toString() : null, Date.now(), signature);
      const actualSol = deltas.solDelta > 0n ? Number(deltas.solDelta) / 1e9 : null;
      const realizedSlippage = actualSol === null || Number(build.outAmount) <= 0
        ? null : (Number(build.outAmount) - Number(deltas.solDelta)) / Number(build.outAmount) * 10_000;
      this.options.db.prepare("UPDATE trade_history SET swap_status='CONFIRMED',swap_signature=?,swap_input_mint=?,swap_sol_received=?,swap_slippage=?,swap_price_impact=?,total_sol_returned=COALESCE(sol_received,0)+COALESCE(?,0),finalized_at=? WHERE position_id=?")
        .run(signature, position.tokenMint, actualSol, realizedSlippage, priceImpact, actualSol, Date.now(), position.id);
      this.options.db.prepare("UPDATE trade_history SET network_fees_sol=COALESCE(network_fees_sol,0)+? WHERE position_id=?")
        .run(Number(deltas.feeLamports) / 1e9, position.id);
      this.options.db.prepare(`INSERT INTO trade_events(trade_id,at,type,payload)
        SELECT trade_id,?,'SWAP_CONFIRMED',? FROM trade_history WHERE position_id=?`)
        .run(Date.now(), JSON.stringify({ signature, receivedLamports: deltas.solDelta.toString() }), position.id);
      this.updatePnl(position.id);
      await this.options.notify(notificationCard("✅ SWAP TERKONFIRMASI", [
        `Posisi ${position.id}`,
        actualSol === null ? "SOL aktual belum dapat dibaca." : `Diterima ${actualSol.toFixed(6)} SOL`,
        `Perkiraan quote ${(Number(build.outAmount) / 1e9).toFixed(6)} SOL · dampak harga ${priceImpact.toFixed(2)}%`,
        `🔗 https://solscan.io/tx/${signature}`,
      ]));
      return;
    }
    saveSwap("NO_ROUTE", { error: lastError });
    this.options.db.prepare("UPDATE trade_history SET swap_status='NO_ROUTE',finalized_at=? WHERE position_id=?").run(Date.now(), position.id);
    this.updatePnl(position.id);
    await this.options.notify(notificationCard("🔴 SWAP GAGAL", [
      `Posisi ${position.id}`,
      `Detail ${lastError}`,
      `Tindakan: periksa rute, lalu gunakan /retryswap ${position.id} untuk mencoba lagi.`,
    ]));
  }

  private async finishSwap(position: Position, amount: bigint, dryRun: boolean, closeSignature?: string): Promise<void> {
    if (this.swapsInFlight.has(position.id)) return;
    this.swapsInFlight.add(position.id);
    try { await this.processSwap(position, amount, dryRun, closeSignature); }
    catch (error) {
      const reason = safeError(error);
      const status = error instanceof UnknownBroadcast ? "UNKNOWN" : "FAILED";
      this.options.db.prepare("UPDATE trade_history SET swap_status=?,finalized_at=? WHERE position_id=?")
        .run(status, Date.now(), position.id);
      this.updatePnl(position.id);
      await this.options.notify(notificationCard(
        status === "UNKNOWN" ? "🚨 STATUS SWAP BELUM DIKETAHUI" : "🔴 SWAP GAGAL",
        [
          `Posisi ${position.id}`,
          `Detail ${reason}`,
          status === "UNKNOWN"
            ? "Periksa signature di journal sebelum mengambil tindakan. Yolow tidak mengirim ulang otomatis."
            : `Periksa rute, lalu gunakan /retryswap ${position.id} untuk mencoba lagi.`,
        ],
      ));
    } finally {
      try { await this.exportCsv(); }
      finally { this.swapsInFlight.delete(position.id); }
    }
  }

  private async exportCsv(): Promise<void> {
    const settings = this.options.config.history.csv_export;
    if (!settings?.enabled) return;
    await persistTradeCsv(this.options.db, this.options.config.timezone, join(settings.dir, settings.file), this.options.config.history.post_exit_marks_min);
  }
}

export function liveModeReply(): string {
  return "⚠️ Live mode akan mengirim transaksi dari wallet agent. Jalankan /golive lagi untuk membuka konfirmasi dua langkah.";
}

export function setLiveMode(db: DatabaseSync, live: boolean): void { setMeta(db, "dry_run", live ? "false" : "true"); }
