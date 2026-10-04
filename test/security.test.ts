import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/storage/db.ts";
import { tradesCsv } from "../src/journal/export.ts";
import { PublicKey } from "@solana/web3.js";
import { jupiterTransactionInstructions } from "../src/execution/executor.ts";
import { readJsonResponse, redactSecrets, safeError, telegramApiBase } from "../src/security.ts";

test("errors remove API credentials, authorization headers, URLs, and control characters", () => {
  const old = process.env.JUPITER_API_KEY;
  const key = "test-secret-key-123456";
  process.env.JUPITER_API_KEY = key;
  try {
    const result = safeError(new Error(`x-api-key: ${key}; Authorization: Bearer abc.def https://rpc.invalid/?api-key=${key}\nnext`));
    assert.equal(result.includes(key), false);
    assert.equal(result.includes("abc.def"), false);
    assert.equal(result.includes("rpc.invalid"), false);
    assert.equal(result.includes("\n"), false);
    assert.equal(redactSecrets(`note JUPITER_API_KEY=${key}`).includes(key), false);
  } finally {
    if (old === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = old;
  }
});

test("API token URL rejects path injection and JSON responses are size limited", async () => {
  assert.equal(telegramApiBase("123456:abcdefghijklmnopqrstuvwxyz_123456789").startsWith("https://api.telegram.org/bot"), true);
  assert.throws(() => telegramApiBase("123456:token/attacker"), /format is invalid/);
  assert.deepEqual(await readJsonResponse(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(readJsonResponse(new Response('{"ok":true}'), 4), /batas ukuran/);
});

test("Jupiter swap instructions are restricted to the router and agent wallet signer", () => {
  const wallet = new PublicKey("11111111111111111111111111111111");
  const swapInstruction = {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    accounts: [{ pubkey: wallet.toBase58(), isSigner: true, isWritable: true }],
    data: "",
  };
  const build = { swapInstruction, setupInstructions: [], otherInstructions: [], tipInstruction: null } as any;
  assert.equal(jupiterTransactionInstructions(build, wallet).length, 1);
  assert.throws(() => jupiterTransactionInstructions({ ...build, swapInstruction: { ...swapInstruction, programId: wallet.toBase58() } }, wallet), /program swap yang tidak diizinkan/);
  assert.throws(() => jupiterTransactionInstructions({ ...build, swapInstruction: { ...swapInstruction, accounts: [{ pubkey: "Vote111111111111111111111111111111111111111", isSigner: true, isWritable: true }] } }, wallet), /signer selain wallet/);
  assert.throws(() => jupiterTransactionInstructions({ ...build, otherInstructions: [swapInstruction] }, wallet), /instruksi tambahan yang tidak diizinkan/);
});

test("trade CSV prefixes spreadsheet formulas and writes from the audit-safe formatter", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(`INSERT INTO trade_history(mode,position_id,pool,token_mint,first_seen_at,entry_source,lower_bin,upper_bin,config_snapshot,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run("dry_run", "position", "pool", "mint", Date.now(), "test", 1, 2, "{}", '=HYPERLINK("https://attacker.invalid","click")');
    const csv = tradesCsv(db, "UTC");
    assert.match(csv, /'=HYPERLINK/);
  } finally { db.close(); }
});
