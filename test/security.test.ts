import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/storage/db.ts";
import { tradesCsv } from "../src/journal/export.ts";
import { readJsonResponse, redactSecrets, safeError, telegramApiBase } from "../src/security.ts";

test("both Helius keys are redacted from errors, Telegram and journal exports", async (t) => {
  const before = [process.env.HELIUS_API_KEY, process.env.HELIUS_API_KEY_BACKUP];
  process.env.HELIUS_API_KEY = "helius-primary-secret";
  process.env.HELIUS_API_KEY_BACKUP = "helius-primary-secret-backup";
  try {
    const text = "helius-primary-secret-backup helius-primary-secret";
    assert.equal(redactSecrets(text), "[redacted] [redacted]");
    assert.equal(safeError(new Error(text)), "[redacted] [redacted]");
    const { notificationCard } = await import("../src/telegram/presentation.ts");
    const card = notificationCard("Test", [text], { mode: "DRY-RUN", timezone: "UTC" });
    assert.doesNotMatch(card.text, /helius-primary-secret/);
    const db = openDatabase(":memory:"); t.after(() => db.close());
    db.prepare(`INSERT INTO trade_history(mode,position_id,pool,token_mint,first_seen_at,entry_source,lower_bin,upper_bin,config_snapshot,notes)
      VALUES('dry_run','test','pool','mint',1,'test',0,1,'{}',?)`).run(text);
    assert.doesNotMatch(tradesCsv(db, "UTC"), /helius-primary-secret/);
  } finally {
    for (const [index, name] of ["HELIUS_API_KEY", "HELIUS_API_KEY_BACKUP"].entries()) {
      if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index];
    }
  }
});

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

test("trade CSV prefixes spreadsheet formulas and writes from the audit-safe formatter", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(`INSERT INTO trade_history(mode,position_id,pool,token_mint,first_seen_at,entry_source,lower_bin,upper_bin,config_snapshot,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run("dry_run", "position", "pool", "mint", Date.now(), "test", 1, 2, "{}", '=HYPERLINK("https://attacker.invalid","click")');
    const csv = tradesCsv(db, "UTC");
    assert.match(csv, /'=HYPERLINK/);
  } finally { db.close(); }
});
