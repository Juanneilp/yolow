import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "../src/meteora.ts";
import { CloseExecutor } from "../src/execution/executor.ts";
import { jupiterTransactionInstructions, validateJupiterSource, validateJupiterWritableAccounts, type JupiterBuild } from "../src/execution/jupiter.ts";
import { openDatabase } from "../src/storage/db.ts";
import { assertFreshCandle, fetchCandleAt, fetchCandleSeries } from "../src/market-data/candles.ts";
import type { Trigger } from "../src/domain/types.ts";

const require = createRequire(import.meta.url);
const { BorshInstructionCoder } = require("@coral-xyz/anchor");
const idl = JSON.parse(readFileSync(new URL("../src/execution/jupiter-idl.json", import.meta.url), "utf8"));
const coder = new BorshInstructionCoder(idl);
const router = new PublicKey(idl.address);
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ataProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const solMint = new PublicKey("So11111111111111111111111111111111111111112");
const signer = Keypair.generate();
const wallet = signer.publicKey;
const mint = Keypair.generate().publicKey;
const poolKey = Keypair.generate().publicKey;
const positionKey = Keypair.generate().publicKey;
const ata = (token: PublicKey) => PublicKey.findProgramAddressSync([wallet.toBuffer(), tokenProgram.toBuffer(), token.toBuffer()], ataProgram)[0];
const intent = { inputMint: mint.toBase58(), amount: 100n, slippageBps: 500, inputTokenProgram: tokenProgram };

function swapBuild(name = "route_v2", amount = 100n): JupiterBuild {
  const schema = idl.instructions.find((item: any) => item.name === name);
  const keys: Record<string, PublicKey> = {
    token_program: tokenProgram, source_token_program: tokenProgram, destination_token_program: tokenProgram,
    user_transfer_authority: wallet, user_source_token_account: ata(mint), source_token_account: ata(mint),
    user_destination_token_account: ata(solMint), destination_token_account: ata(solMint),
    source_mint: mint, destination_mint: solMint,
    platform_fee_account: router, token_2022_program: router, program: router,
  };
  const v2 = name.endsWith("v2");
  const args = {
    id: 0, in_amount: new BN(amount.toString()), quoted_out_amount: new BN(1000000000),
    slippage_bps: 500, platform_fee_bps: 0, positive_slippage_bps: 0,
    route_plan: [{ swap: { Saber: {} }, ...(v2 ? { bps: 10000 } : { percent: 100 }), input_index: 0, output_index: 1 }],
  };
  return {
    inputMint: mint.toBase58(), outputMint: solMint.toBase58(), inAmount: amount.toString(),
    outAmount: "1000000000", otherAmountThreshold: "950000000", slippageBps: 500, swapMode: "ExactIn", priceImpact: 1,
    swapInstruction: {
      programId: router.toBase58(),
      accounts: schema.accounts.map((account: any) => ({
        pubkey: (account.address ? new PublicKey(account.address) : keys[account.name] ?? Keypair.generate().publicKey).toBase58(),
        isSigner: !!account.signer, isWritable: !!account.writable && !(keys[account.name]?.equals(router)),
      })),
      data: coder.encode(name, args).toString("base64"),
    },
    setupInstructions: [{ programId: ataProgram.toBase58(), data: "AQ==", accounts: [
      { pubkey: wallet.toBase58(), isSigner: true, isWritable: true },
      { pubkey: ata(solMint).toBase58(), isSigner: false, isWritable: true },
      { pubkey: wallet.toBase58(), isSigner: false, isWritable: false },
      { pubkey: solMint.toBase58(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
      { pubkey: tokenProgram.toBase58(), isSigner: false, isWritable: false },
    ] }],
    cleanupInstruction: { programId: tokenProgram.toBase58(), data: "CQ==", accounts: [
      { pubkey: ata(solMint).toBase58(), isSigner: false, isWritable: true },
      { pubkey: wallet.toBase58(), isSigner: false, isWritable: true },
      { pubkey: wallet.toBase58(), isSigner: true, isWritable: false },
    ] },
    blockhashWithMetadata: { blockhash: Array(32).fill(1), lastValidBlockHeight: 999 },
  };
}

test("SEC 01 accepts pinned exact-in layouts and rejects altered monetary fields and accounts", () => {
  for (const schema of idl.instructions) assert.equal(jupiterTransactionInstructions(swapBuild(schema.name), wallet, intent).length, 3);
  const cases: Array<(build: JupiterBuild) => void> = [
    (b) => { b.swapInstruction!.data = swapBuild("route_v2", 101n).swapInstruction!.data; },
    (b) => { const raw = Buffer.from(b.swapInstruction!.data, "base64"); raw.writeUInt16LE(1500, 24); b.swapInstruction!.data = raw.toString("base64"); },
    (b) => { const raw = Buffer.from(b.swapInstruction!.data, "base64"); raw.writeUInt16LE(100, 26); b.swapInstruction!.data = raw.toString("base64"); },
    (b) => { b.otherAmountThreshold = "1"; },
    (b) => { b.swapInstruction!.accounts[2].pubkey = Keypair.generate().publicKey.toBase58(); },
    (b) => { b.swapInstruction!.accounts[3].pubkey = solMint.toBase58(); },
    (b) => { b.swapInstruction!.accounts[0].pubkey = Keypair.generate().publicKey.toBase58(); },
    (b) => { b.swapInstruction!.data = Buffer.alloc(32, 255).toString("base64"); },
    (b) => { b.swapInstruction!.programId = wallet.toBase58(); },
    (b) => { b.swapInstruction!.data = Buffer.concat([Buffer.from(b.swapInstruction!.data, "base64"), Buffer.from([1])]).toString("base64"); },
    (b) => { b.setupInstructions![0].data = "Ag=="; },
    (b) => { b.setupInstructions![0].accounts[1].pubkey = ata(mint).toBase58(); },
    (b) => { b.cleanupInstruction!.data = "Aw=="; },
    (b) => { b.cleanupInstruction!.accounts[0].pubkey = ata(mint).toBase58(); },
    (b) => { b.cleanupInstruction = null; },
    (b) => { b.otherInstructions = [b.swapInstruction!]; },
  ];
  for (const change of cases) { const build = swapBuild(); change(build); assert.throws(() => jupiterTransactionInstructions(build, wallet, intent)); }
});

test("SEC 01 validates a real Jupiter API build with normalized wallet and preserves integer rounding", () => {
  // Read-only /build response from 2026-10-14, with wallet and its ATAs replaced.
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/jupiter-build.json", import.meta.url), "utf8"));
  const request = { inputMint: fixture.build.inputMint, amount: BigInt(fixture.build.inAmount), slippageBps: 500, inputTokenProgram: tokenProgram };
  assert.equal(jupiterTransactionInstructions(fixture.build, new PublicKey(fixture.wallet), request).length, 3);
  fixture.build.otherAmountThreshold = (BigInt(fixture.build.otherAmountThreshold) - 1n).toString();
  assert.throws(() => jupiterTransactionInstructions(fixture.build, new PublicKey(fixture.wallet), request), /slippage/);
});

function tokenAccount(owner = wallet, token = mint) {
  const data = Buffer.alloc(165); token.toBuffer().copy(data, 0); owner.toBuffer().copy(data, 32);
  return { owner: tokenProgram, data, lamports: 1, executable: false, rentEpoch: 0 };
}

test("SEC 01 reads token account ownership and rejects access to unrelated wallet tokens", async () => {
  const connection = { getAccountInfo: async (key: PublicKey) => key.equals(mint) ? { owner: tokenProgram } : tokenAccount() } as unknown as Connection;
  assert.ok((await validateJupiterSource(connection, wallet, mint.toBase58())).equals(tokenProgram));
  connection.getAccountInfo = async () => tokenAccount(Keypair.generate().publicKey) as any;
  await assert.rejects(validateJupiterSource(connection, wallet, mint.toBase58()), /ATA/);
  const instructions = jupiterTransactionInstructions(swapBuild(), wallet, intent);
  instructions[1].keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true });
  connection.getMultipleAccountsInfo = async (keys) => keys.map(() => tokenAccount());
  await assert.rejects(validateJupiterWritableAccounts(connection, wallet, intent, instructions), /di luar hasil close/);
});

function harness() {
  const db = openDatabase(":memory:");
  const config = JSON.parse(readFileSync("config.example.json", "utf8"));
  config.mode.dry_run = false; config.execution.max_retries = 1; config.swap.enabled = false;
  config.history.csv_export.enabled = false; config.history.post_exit_marks_min = [];
  db.prepare(`INSERT INTO positions(id,pool,token_mint,quote_mint,lower_bin_id,upper_bin_id,first_seen_at,state,last_checked)
    VALUES(?,?,?,?,0,1,0,'OPEN',0)`).run(positionKey.toBase58(), poolKey.toBase58(), mint.toBase58(), solMint.toBase58());
  db.prepare(`INSERT INTO trade_history(mode,position_id,pool,token_mint,first_seen_at,entry_source,lower_bin,upper_bin,config_snapshot)
    VALUES('live',?,?,?,?, 'test',0,1,'{}')`).run(positionKey.toBase58(), poolKey.toBase58(), mint.toBase58(), 0);
  const broadcasts: Buffer[] = [];
  const notifications: string[] = [];
  const delta = { meta: { err: null, preBalances: [10000000000], postBalances: [11000000000], fee: 5000,
    preTokenBalances: [], postTokenBalances: [{ mint: mint.toBase58(), owner: wallet.toBase58(), uiTokenAmount: { amount: "100" } }] },
    transaction: { message: { accountKeys: [wallet] } } };
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999 }),
    simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 1000 } }),
    sendRawTransaction: async (raw: Buffer) => { broadcasts.push(raw); return "mock"; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getTransaction: async () => delta,
    getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "500" } } } } } }] }),
    getAccountInfo: async (key: PublicKey) => key.equals(mint) ? { owner: tokenProgram } : tokenAccount(),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => key.equals(ata(mint)) ? tokenAccount() : null),
  } as unknown as Connection;
  const options = { db, config, wallet, connection, keypair: signer, jupiterApiKey: "test", notify: async (message: string) => { notifications.push(message); } };
  const executor = new CloseExecutor(options);
  const position = { id: positionKey.toBase58(), pool: poolKey.toBase58(), tokenMint: mint.toBase58(), quoteMint: solMint.toBase58(),
    lowerBinId: 0, upperBinId: 1, firstSeenAt: 0, ignored: false, state: "CLOSED" as const };
  const now = Date.now();
  const candleTime = Math.floor((now - config.candles.grace_window_sec * 1000) / 300000) * 300000 - 300000;
  const trigger: Trigger = { positionId: position.id, pool: position.pool, reason: "INDICATOR", detectedAt: now, confirmedAt: now,
    detail: { candleTime, timeframe: "5m", unit: "usd", close: 1 } };
  return { db, config, connection, executor, options, position, trigger, broadcasts, notifications, delta };
}

function confirmedClose(h: ReturnType<typeof harness>, amount = "100") {
  h.db.prepare("INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at) VALUES('close','CLOSE',?,?,'CONFIRMED',0)").run(h.position.id, h.position.pool);
  h.db.prepare("INSERT INTO close_results(position_id,token_mint,token_received,sol_received_lamports,signature,mode,status,created_at) VALUES(?,?,?,'0','close','live','CONFIRMED',0)")
    .run(h.position.id, h.position.tokenMint, amount);
}

test("SEC 02 rejects old failures followed by success or unsettled attempts and caps remaining proceeds", async () => {
  for (const status of ["CONFIRMED", "PENDING", "UNKNOWN"]) {
    const h = harness();
    try {
      confirmedClose(h);
      const put = h.db.prepare("INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,status,created_at,updated_at) VALUES(?,'close',?,'100',?,0,0)");
      put.run(h.position.id, mint.toBase58(), "FAILED"); put.run(h.position.id, mint.toBase58(), status);
      h.config.swap.enabled = true;
      await assert.rejects(h.executor.retrySwap(h.position.id), /terbaru/);
      assert.equal(h.broadcasts.length, 0);
    } finally { h.db.close(); }
  }
  const h = harness();
  try {
    confirmedClose(h);
    h.db.prepare("INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at) VALUES('sold','SWAP',?,?,'CONFIRMED',0)").run(h.position.id, h.position.pool);
    h.db.prepare("INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,status,signature,created_at,updated_at) VALUES(?,'close',?,'40','CONFIRMED','sold',0,0)").run(h.position.id, mint.toBase58());
    assert.equal(await (h.executor as any).remainingSwapAmount(h.position, "close"), 60n);
    h.db.prepare("UPDATE swaps SET input_amount='100' WHERE signature='sold'").run();
    await assert.rejects((h.executor as any).remainingSwapAmount(h.position, "close"), /sudah ditukar/);
    h.db.prepare("INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at) VALUES('orphan','SWAP',?,?,'CONFIRMED',0)").run(h.position.id, h.position.pool);
    await assert.rejects((h.executor as any).remainingSwapAmount(h.position, "close"), /Catatan input/);
  } finally { h.db.close(); }
});

async function withPool(operation: () => Promise<void>) {
  const oldCreate = DLMM.create;
  const oldDiscover = DLMM.getAllLbPairPositionsByUser;
  DLMM.create = (async () => ({
    getPosition: async () => ({ positionData: { owner: wallet } }),
    removeLiquidity: async () => [new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: poolKey, lamports: 1 }))],
  })) as any;
  DLMM.getAllLbPairPositionsByUser = (async () => new Map()) as any;
  try { await operation(); } finally { DLMM.create = oldCreate; DLMM.getAllLbPairPositionsByUser = oldDiscover; }
}

test("SEC 03 archives finalized dry-run journal and still executes a live close exactly once", async () => {
  await withPool(async () => {
    const h = harness();
    try {
      h.db.prepare("UPDATE trade_history SET mode='dry_run',finalized_at=1,tokens_received='999',swap_sol_received=999").run();
      h.db.prepare("INSERT INTO close_results(position_id,token_mint,mode,status,created_at) VALUES(?,?,'dry_run','DRY_RUN',0)").run(h.position.id, mint.toBase58());
      await h.executor.execute(h.trigger);
      assert.equal(h.broadcasts.length, 1);
      const row = h.db.prepare("SELECT mode,tokens_received,swap_sol_received FROM trade_history").get();
      assert.deepEqual({ ...row }, { mode: "live", tokens_received: "100", swap_sol_received: null });
      const archived = h.db.prepare("SELECT payload FROM trade_events WHERE type='DRY_RUN_ARCHIVED'").get() as { payload: string };
      assert.equal(JSON.parse(archived.payload).trade.tokens_received, "999");
      await h.executor.execute(h.trigger);
      assert.equal(h.broadcasts.length, 1);
    } finally { h.db.close(); }
  });
});

test("SEC 04 confirmed close waits for metadata and recovers after restart without resending", async () => {
  await withPool(async () => {
    const h = harness();
    try {
      h.connection.getTransaction = async () => ({ meta: null }) as any;
      await h.executor.execute(h.trigger);
      assert.equal(h.broadcasts.length, 1);
      assert.equal(h.db.prepare("SELECT status FROM transactions").get()!.status, "CONFIRMED");
      assert.equal(h.db.prepare("SELECT finalized_at FROM trade_history").get()!.finalized_at, null);
      assert.equal(h.db.prepare("SELECT swap_status FROM trade_history").get()!.swap_status, "WAITING_METADATA");
      const restarted = new CloseExecutor(h.options);
      await restarted.reconcileTransactions();
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM close_results").get()!.n, 0);
      h.connection.getTransaction = async () => h.delta as any;
      await restarted.reconcileTransactions();
      assert.equal(h.db.prepare("SELECT token_received FROM close_results").get()!.token_received, "100");
      assert.equal(h.db.prepare("SELECT swap_status FROM trade_history").get()!.swap_status, "SKIPPED_DISABLED");
      assert.ok(h.db.prepare("SELECT finalized_at FROM trade_history").get()!.finalized_at);
      assert.equal(h.broadcasts.length, 1);
    } finally { h.db.close(); }
  });
});

async function withJupiter(operation: () => Promise<void>) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname.includes("price")) return new Response(JSON.stringify({ [solMint.toBase58()]: { usdPrice: 100 } }));
    return new Response(JSON.stringify(swapBuild("route_v2", BigInt(url.searchParams.get("amount")!))));
  }) as typeof fetch;
  try { await operation(); } finally { globalThis.fetch = oldFetch; }
}

test("SEC 02 two concurrent retries broadcast at most one swap and reject older unsettled transactions", async () => {
  await withJupiter(async () => {
    const h = harness();
    try {
      confirmedClose(h);
      h.config.swap.enabled = true;
      h.db.prepare("INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,status,created_at,updated_at) VALUES(?,'close',?,'100','FAILED',0,0)")
        .run(h.position.id, mint.toBase58());
      const first = h.executor.retrySwap(h.position.id);
      await assert.rejects(h.executor.retrySwap(h.position.id), /sedang berjalan/);
      await first;
      assert.equal(h.broadcasts.length, 1);
      assert.equal(h.db.prepare("SELECT status FROM swaps ORDER BY id DESC LIMIT 1").get()!.status, "CONFIRMED");
      await assert.rejects(h.executor.retrySwap(h.position.id), /terbaru/);
      h.db.prepare("INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at) VALUES('unknown','SWAP',?,?,'UNKNOWN',0)")
        .run(h.position.id, h.position.pool);
      h.db.prepare("INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,status,created_at,updated_at) VALUES(?,'close',?,'100','FAILED',0,0)")
        .run(h.position.id, mint.toBase58());
      await assert.rejects(h.executor.retrySwap(h.position.id), /belum selesai/);
      assert.equal(h.broadcasts.length, 1);
    } finally { h.db.close(); }
  });
});

test("SEC 04 confirmed swap with delayed metadata recovers after restart and cannot be retried", async () => {
  await withPool(async () => withJupiter(async () => {
    const h = harness();
    try {
      confirmedClose(h);
      h.config.swap.enabled = true;
      h.connection.getTransaction = async () => ({ meta: null }) as any;
      await (h.executor as any).finishSwap(h.position, 100n, false, "close");
      assert.equal(h.broadcasts.length, 1);
      assert.equal(h.db.prepare("SELECT status FROM swaps").get()!.status, "CONFIRMED");
      assert.equal(h.db.prepare("SELECT finalized_at FROM trade_history").get()!.finalized_at, null);
      const waiting = new CloseExecutor(h.options);
      await waiting.reconcileTransactions();
      assert.equal(h.db.prepare("SELECT finalized_at FROM trade_history").get()!.finalized_at, null);
      assert.equal(h.db.prepare("SELECT swap_status FROM trade_history").get()!.swap_status, "WAITING_METADATA");
      h.db.prepare("INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,status,created_at,updated_at) VALUES(?,'close',?,'100','FAILED',0,0)")
        .run(h.position.id, mint.toBase58());
      await assert.rejects(h.executor.retrySwap(h.position.id), /sudah ditukar/);
      h.connection.getTransaction = async () => h.delta as any;
      const restarted = new CloseExecutor(h.options);
      await restarted.reconcileTransactions();
      assert.equal(h.db.prepare("SELECT swap_status FROM trade_history").get()!.swap_status, "CONFIRMED");
      assert.ok(h.db.prepare("SELECT finalized_at FROM trade_history").get()!.finalized_at);
      await restarted.reconcileTransactions();
      assert.equal(h.broadcasts.length, 1);
      assert.equal(h.db.prepare("SELECT network_fees_sol FROM trade_history").get()!.network_fees_sol, 0.000005);
    } finally { h.db.close(); }
  }));
});

test("SEC 04 actual zero proceeds are finalized while incomplete token ownership waits", async () => {
  await withPool(async () => {
    const h = harness();
    try {
      h.delta.meta.postTokenBalances = [];
      h.config.swap.enabled = true;
      await h.executor.execute(h.trigger);
      assert.equal(h.db.prepare("SELECT swap_status FROM trade_history").get()!.swap_status, "SKIPPED_NO_TOKEN");
      assert.ok(h.db.prepare("SELECT finalized_at FROM trade_history").get()!.finalized_at);
      h.delta.meta.postTokenBalances = [{ mint: mint.toBase58(), uiTokenAmount: { amount: "100" } }] as any;
      await assert.rejects((h.executor as any).transactionDeltas("signature", mint.toBase58()), /belum lengkap/);
    } finally { h.db.close(); }
  });
});

test("SEC 04 recovery accounts each confirmed swap once and totals multiple receipts", async () => {
  await withPool(async () => {
    const h = harness();
    try {
      confirmedClose(h);
      for (const signature of ["old-swap", "new-swap"]) {
        h.db.prepare("INSERT INTO transactions(signature,kind,position_id,pool,status,sent_at) VALUES(?,'SWAP',?,?,'CONFIRMED',0)").run(signature, h.position.id, h.position.pool);
        h.db.prepare("INSERT INTO swaps(position_id,close_signature,input_mint,input_amount,status,signature,sol_received_lamports,created_at,updated_at) VALUES(?,'close',?,'50','CONFIRMED',?,?,0,0)")
          .run(h.position.id, mint.toBase58(), signature, signature === "old-swap" ? "1000000000" : null);
      }
      h.db.prepare("UPDATE trade_history SET network_fees_sol=0.000005").run();
      await h.executor.reconcileTransactions();
      await h.executor.reconcileTransactions();
      const row = h.db.prepare("SELECT swap_sol_received,network_fees_sol FROM trade_history").get()!;
      assert.equal(row.swap_sol_received, 2.000005);
      assert.equal(row.network_fees_sol, 0.00001);
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM trade_events WHERE type='SWAP_CONFIRMED'").get()!.n, 1);
      assert.equal(h.broadcasts.length, 0);
    } finally { h.db.close(); }
  });
});

test("SEC 03 and SEC 04 recovery swaps live proceeds once despite earlier simulated swaps", async () => {
  await withPool(async () => withJupiter(async () => {
    const h = harness();
    try {
      h.config.swap.enabled = true;
      h.db.prepare("UPDATE trade_history SET mode='dry_run',finalized_at=1").run();
      h.db.prepare("INSERT INTO swaps(position_id,input_mint,input_amount,status,created_at,updated_at) VALUES(?,?,'999','DRY_RUN_QUOTED',0,0)")
        .run(h.position.id, mint.toBase58());
      h.connection.getTransaction = async () => ({ meta: null }) as any;
      await h.executor.execute(h.trigger);
      assert.equal(h.broadcasts.length, 1);
      h.connection.getTransaction = async () => h.delta as any;
      const restarted = new CloseExecutor(h.options);
      await restarted.reconcileTransactions();
      assert.equal(h.broadcasts.length, 2);
      assert.equal(h.db.prepare("SELECT swap_status FROM trade_history").get()!.swap_status, "CONFIRMED");
      await restarted.reconcileTransactions();
      assert.equal(h.broadcasts.length, 2);
    } finally { h.db.close(); }
  }));
});

test("SEC 05 a fresh signal that expires during preparation is rejected before broadcast", async () => {
  await withPool(async () => {
    const h = harness();
    try {
      h.connection.simulateTransaction = (async () => {
        h.trigger.detail.candleTime = Date.now() - 86400000;
        return { value: { err: null } };
      }) as any;
      await h.executor.execute(h.trigger);
      assert.equal(h.broadcasts.length, 0);
      assert.equal(h.db.prepare("SELECT outcome FROM triggers ORDER BY id DESC LIMIT 1").get()!.outcome, "STALE_CANDLE");
    } finally { h.db.close(); }
  });
});

test("SEC 05 rejects queued stale triggers before broadcast", async () => {
  await withPool(async () => {
    const h = harness();
    try {
      h.trigger.detail.candleTime = Date.now() - 86400000;
      await h.executor.execute(h.trigger);
      assert.equal(h.broadcasts.length, 0);
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM transactions").get()!.n, 0);
    } finally { h.db.close(); }
  });
});

test("SEC 05 stale HTTP success falls back to fresh candles and historical marks remain usable", async () => {
  const h = harness();
  const oldFetch = globalThis.fetch;
  const now = Date.parse("2026-10-14T12:00:00Z");
  h.config.candles.primary = "meteora"; h.config.candles.fallback_chain = ["geckoterminal"];
  h.config.candles.grace_window_sec = 0; h.config.candles.backfill_candles = 35;
  const rows = (end: number) => Array.from({ length: 35 }, (_, i) => [end / 1000 - (35 - i) * 300, 1, 1, 1, 1, 1]);
  let stale = true;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.hostname === "api.geckoterminal.com") return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: rows(now) } } }));
    const end = stale ? now - 86400000 : Math.floor(Number(url.searchParams.get("end_time")) / 300) * 300000;
    return new Response(JSON.stringify({ data: rows(end) }));
  }) as typeof fetch;
  try {
    const series = await fetchCandleSeries("pool", "5m", h.config, now);
    assert.equal(series.at(-1)!.provider, "geckoterminal");
    h.config.candles.fallback_chain = [];
    await assert.rejects(fetchCandleSeries("pool", "5m", h.config, now), /kedaluwarsa/);
    stale = false;
    assert.ok((await fetchCandleSeries("pool", "5m", h.config, now)).length);
    const historic = now - 86400000;
    assert.equal((await fetchCandleAt("pool", "5m", h.config, historic)).time, historic);
    assert.throws(() => assertFreshCandle(now - 86400000, "5m", h.config.candles, now), /kedaluwarsa/);
  } finally { globalThis.fetch = oldFetch; h.db.close(); }
});
