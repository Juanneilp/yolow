import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const { BorshInstructionCoder } = require("@coral-xyz/anchor");
// Snapshot of the on-chain IDL on 2026-10-14; unknown router layouts fail closed.
const idl = JSON.parse(readFileSync(new URL("./jupiter-idl.json", import.meta.url), "utf8"));
const coder = new BorshInstructionCoder(idl);
const ROUTER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export type JupiterInstruction = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
};

export type JupiterBuild = {
  inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string;
  otherAmountThreshold?: string; slippageBps?: number; swapMode?: string;
  priceImpact?: number; priceImpactPct?: string; error?: string; errorMessage?: string;
  setupInstructions?: JupiterInstruction[]; swapInstruction?: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction | null; otherInstructions?: JupiterInstruction[];
  tipInstruction?: JupiterInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]> | null;
  blockhashWithMetadata?: { blockhash: number[]; lastValidBlockHeight: number };
};

export type SwapIntent = { inputMint: string; amount: bigint; slippageBps: number; inputTokenProgram: PublicKey };

function ata(wallet: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([wallet.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

export async function validateJupiterSource(connection: Connection, wallet: PublicKey, mint: string): Promise<PublicKey> {
  const mintKey = new PublicKey(mint);
  const mintAccount = await connection.getAccountInfo(mintKey, "confirmed");
  const program = mintAccount?.owner;
  if (!program || (!program.equals(TOKEN_PROGRAM) && !program.equals(TOKEN_2022))) throw new Error("Mint sumber Jupiter tidak valid");
  const account = await connection.getAccountInfo(ata(wallet, mintKey, program), "confirmed");
  if (!account || !account.owner.equals(program) || account.data.length < 165 ||
      !new PublicKey(account.data.subarray(0, 32)).equals(mintKey) ||
      !new PublicKey(account.data.subarray(32, 64)).equals(wallet)) {
    throw new Error("Akun sumber Jupiter harus merupakan ATA dengan mint dan owner wallet agent");
  }
  return program;
}

export async function validateJupiterWritableAccounts(connection: Connection, wallet: PublicKey, intent: SwapIntent, instructions: TransactionInstruction[]): Promise<void> {
  const allowed = new Set([ata(wallet, new PublicKey(intent.inputMint), intent.inputTokenProgram).toBase58(), ata(wallet, SOL_MINT, TOKEN_PROGRAM).toBase58()]);
  const addresses = [...new Map(instructions.flatMap((item) => item.keys).filter((key) => key.isWritable && !key.pubkey.equals(wallet))
    .map((key) => [key.pubkey.toBase58(), key.pubkey])).values()];
  for (let offset = 0; offset < addresses.length; offset += 100) {
    const batch = addresses.slice(offset, offset + 100);
    const accounts = await connection.getMultipleAccountsInfo(batch, "confirmed");
    for (const [index, account] of accounts.entries()) {
      if (account && (account.owner.equals(TOKEN_PROGRAM) || account.owner.equals(TOKEN_2022)) && account.data.length >= 165 &&
          new PublicKey(account.data.subarray(32, 64)).equals(wallet) && !allowed.has(batch[index].toBase58())) {
        throw new Error("Jupiter meminta akses ke akun token wallet di luar hasil close");
      }
    }
  }
}

function instruction(value: JupiterInstruction, wallet: PublicKey, allowed: PublicKey): TransactionInstruction {
  if (!value || value.programId !== allowed.toBase58() || !Array.isArray(value.accounts) ||
      value.accounts.length > 256 || typeof value.data !== "string" || value.data.length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    throw new Error("Jupiter mengembalikan program atau format instruksi yang tidak diizinkan");
  }
  const keys = value.accounts.map((account) => {
    if (typeof account?.pubkey !== "string" || typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") {
      throw new Error("Jupiter account meta tidak valid");
    }
    if (account.isSigner && account.pubkey !== wallet.toBase58()) throw new Error("Jupiter meminta signer selain wallet agent");
    return { pubkey: new PublicKey(account.pubkey), isSigner: account.isSigner, isWritable: account.isWritable };
  });
  const data = Buffer.from(value.data, "base64");
  if (data.length > 1232) throw new Error("Data instruksi Jupiter melebihi batas transaksi");
  return new TransactionInstruction({ programId: allowed, keys, data });
}

export function jupiterTransactionInstructions(build: JupiterBuild, wallet: PublicKey, intent: SwapIntent): TransactionInstruction[] {
  if ((!intent.inputTokenProgram.equals(TOKEN_PROGRAM) && !intent.inputTokenProgram.equals(TOKEN_2022)) ||
      intent.inputMint === SOL_MINT.toBase58() || intent.amount <= 0n || intent.amount > 0xffffffffffffffffn ||
      !Number.isInteger(intent.slippageBps) || intent.slippageBps < 1 || intent.slippageBps >= 10_000) {
    throw new Error("Tujuan swap Jupiter tidak valid");
  }
  const inputMint = new PublicKey(intent.inputMint);
  const source = ata(wallet, inputMint, intent.inputTokenProgram);
  const destination = ata(wallet, SOL_MINT, TOKEN_PROGRAM);
  const setup = build.setupInstructions ?? [];
  if (!Array.isArray(setup) || setup.length > 2 ||
      (build.otherInstructions !== undefined && (!Array.isArray(build.otherInstructions) || build.otherInstructions.length !== 0)) || build.tipInstruction) {
    throw new Error("Jupiter mengembalikan instruksi tambahan yang tidak diizinkan");
  }
  const seen = new Set<string>();
  const instructions = setup.map((value) => {
    const result = instruction(value, wallet, ATA_PROGRAM);
    const keys = result.keys;
    const output = keys[1]?.pubkey.equals(destination);
    const mint = output ? SOL_MINT : inputMint;
    const program = output ? TOKEN_PROGRAM : intent.inputTokenProgram;
    if (keys.length !== 6 || !keys[0].pubkey.equals(wallet) || !keys[0].isSigner || !keys[0].isWritable ||
        !keys[1].pubkey.equals(ata(wallet, mint, program)) || !keys[1].isWritable ||
        !keys[2].pubkey.equals(wallet) || !keys[3].pubkey.equals(mint) ||
        !keys[4].pubkey.equals(SystemProgram.programId) || !keys[5].pubkey.equals(program) ||
        result.data.length > 1 || (result.data.length === 1 && ![0, 1].includes(result.data[0])) ||
        seen.has(keys[1].pubkey.toBase58())) throw new Error("Jupiter setup ATA tidak sesuai tujuan swap");
    seen.add(keys[1].pubkey.toBase58());
    return result;
  });
  const swap = instruction(build.swapInstruction!, wallet, ROUTER);
  let decoded: any;
  try {
    decoded = coder.decode(swap.data);
    if (!decoded || !coder.encode(decoded.name, decoded.data).equals(swap.data)) throw new Error();
  } catch { throw new Error("Format instruksi swap Jupiter tidak didukung"); }
  const args = decoded.data;
  const input = BigInt(args.in_amount.toString());
  const output = BigInt(args.quoted_out_amount.toString());
  const minimum = output - output * BigInt(intent.slippageBps) / 10_000n;
  if (input !== intent.amount || output <= 0n || output.toString() !== build.outAmount ||
      args.slippage_bps !== intent.slippageBps || args.platform_fee_bps !== 0 ||
      (args.positive_slippage_bps ?? 0) !== 0 || !Array.isArray(args.route_plan) || !args.route_plan.length ||
      !build.otherAmountThreshold || !/^\d{1,20}$/.test(build.otherAmountThreshold) ||
      minimum <= 0n || BigInt(build.otherAmountThreshold) !== minimum) {
    throw new Error("Jumlah atau slippage instruksi Jupiter tidak sesuai tujuan swap");
  }
  const schema = idl.instructions.find((item: any) => item.name === decoded.name);
  const expected: Record<string, PublicKey> = {
    user_transfer_authority: wallet, user_source_token_account: source, source_token_account: source,
    user_destination_token_account: destination, destination_token_account: destination,
    source_mint: inputMint, destination_mint: SOL_MINT,
    token_program: intent.inputTokenProgram, source_token_program: intent.inputTokenProgram,
    destination_token_program: TOKEN_PROGRAM, token_2022_program: TOKEN_2022,
    program: ROUTER, platform_fee_account: ROUTER,
  };
  if (swap.keys.length < schema.accounts.length) throw new Error("Akun instruksi Jupiter tidak lengkap");
  for (const [index, account] of schema.accounts.entries()) {
    const key = swap.keys[index];
    const required = account.address ? new PublicKey(account.address) : expected[account.name];
    const absent = account.optional && key.pubkey.equals(ROUTER);
    if ((!absent && required && !key.pubkey.equals(required)) ||
        (account.signer && !key.isSigner) || (!absent && account.writable && !key.isWritable)) {
      throw new Error("Mint atau penerima instruksi Jupiter tidak sesuai wallet agent");
    }
  }
  instructions.push(swap);
  if (!build.cleanupInstruction) throw new Error("Jupiter harus mengembalikan hasil wrapped SOL ke wallet agent");
  const cleanup = instruction(build.cleanupInstruction, wallet, TOKEN_PROGRAM);
  if (cleanup.data.length !== 1 || cleanup.data[0] !== 9 || cleanup.keys.length !== 3 ||
      !cleanup.keys[0].pubkey.equals(destination) || !cleanup.keys[0].isWritable ||
      !cleanup.keys[1].pubkey.equals(wallet) || !cleanup.keys[1].isWritable ||
      !cleanup.keys[2].pubkey.equals(wallet) || !cleanup.keys[2].isSigner) {
    throw new Error("Jupiter cleanup harus menutup ATA wrapped SOL ke wallet agent");
  }
  instructions.push(cleanup);
  return instructions;
}
