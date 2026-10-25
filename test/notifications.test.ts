import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { notificationCard, notificationSol, notificationPercent, notificationTime, swapStatusLabel } from "../src/telegram/presentation.ts";
import { sendTelegramMessage } from "../src/telegram/client.ts";
import { openDatabase } from "../src/storage/db.ts";
import { parseConfig } from "../src/config/config.ts";
import { YolowAgent } from "../src/agent.ts";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();

function assertSafeLines(text: string): void {
  for (const line of text.split("\n")) {
    assert.ok(line.length <= 3500);
    const stack: string[] = [];
    for (const tag of line.matchAll(/<(\/)?(b|code)>/g)) {
      if (tag[1]) assert.equal(stack.pop(), tag[2]); else stack.push(tag[2]);
    }
    assert.equal(stack.length, 0);
    assert.doesNotMatch(line.replace(/<\/?(?:b|code)>/g, ""), /[<>]/);
  }
}

test("notification cards escape labels and secrets, preserve copyable addresses and validate action links", (t) => {
  const previous = process.env.JUPITER_API_KEY;
  process.env.JUPITER_API_KEY = "private-test-secret";
  t.after(() => { if (previous === undefined) delete process.env.JUPITER_API_KEY; else process.env.JUPITER_API_KEY = previous; });
  const card = notificationCard("🟡 CLOSE <b>SELESAI</b>", [
    { label: "PnL", value: "<0,00000001 SOL" },
    { label: "Detail", value: 'x-api-key: private-test-secret <script> & "x"' },
    "one\ntwo <i>name</i>",
  ], { subtitle: 'TOKEN <img src="x">/SOL', mode: "DRY-RUN", positionId: key(1), pool: key(2), mint: key(3),
    timezone: "Asia/Jakarta", at: Date.UTC(2026, 9, 25, 9, 0), detailCallback: `position:view:${key(1)}`, action: "history" });
  assertSafeLines(card.text);
  assert.equal(card.parseMode, "HTML");
  assert.match(card.text, /&lt;img/); assert.doesNotMatch(card.text, /private-test-secret/);
  assert.match(card.text, /&lt;0,00000001 SOL/);
  assert.ok(card.text.includes(`<code>${key(1)}</code>`));
  assert.ok(card.text.includes(`<code>${key(2)}</code>`));
  const buttons = (card.replyMarkup!.inline_keyboard as any[][]).flat();
  assert.ok(buttons.some((b) => b.callback_data === `position:view:${key(1)}`));
  assert.ok(buttons.some((b) => b.url === `https://app.meteora.ag/dlmm/${key(2)}`));
  assert.ok(buttons.some((b) => b.callback_data === "cmd:/history"));
  const invalid = notificationCard("test", [], { pool: 'javascript:alert(1)', detailCallback: 'cmd:/golive' });
  assert.equal((invalid.replyMarkup!.inline_keyboard as any[][]).flat().length, 1);
});

test("notification formatting distinguishes unavailable, tiny, positive and negative values and configured timezones", () => {
  assert.equal(notificationSol(0n, true), "0,00000000 SOL");
  assert.equal(notificationSol(1n, true), "+<0,00000001 SOL");
  assert.equal(notificationSol(-1n, true), "−<0,00000001 SOL");
  assert.equal(notificationSol(500000000n), "0,50000000 SOL");
  assert.equal(notificationSol(null), "Belum tersedia");
  assert.equal(notificationSol(NaN), "Belum tersedia");
  assert.equal(notificationPercent(5, true), "+5,00%");
  assert.equal(notificationPercent(null), "Belum tersedia");
  assert.equal(swapStatusLabel("DRY_RUN_QUOTED"), "Quote simulasi berhasil");
  assert.equal(swapStatusLabel("SKIPPED_DUST"), "Dilewati · nilai dust");
  const at = Date.UTC(2026, 9, 25, 9, 0);
  assert.match(notificationTime(at, "Asia/Jakarta"), /16\.00\.00 WIB/);
  assert.match(notificationTime(at, "Asia/Shanghai"), /17\.00\.00/);
  assert.doesNotMatch(notificationTime(at, "Asia/Shanghai"), /WIB/);
});

test("shared sender splits HTML into valid chunks with buttons only on the first and previews disabled", async (t) => {
  const sent: any[] = [];
  t.mock.method(globalThis, "fetch", async (_input: any, init: any) => {
    sent.push(JSON.parse(init.body)); return Response.json({ ok: true });
  });
  const card = notificationCard("TITLE", Array.from({ length: 90 }, (_, i) => ({ label: `Item ${i}`, value: "<name> & value ".repeat(12) })),
    { mode: "DRY-RUN", pool: key(2) });
  await sendTelegramMessage("123:test", "42", card);
  assert.ok(sent.length > 1);
  assert.equal(sent.reduce((sum, p) => sum + (p.text.match(/Item \d+/g)?.length ?? 0), 0), 90);
  for (const [index, payload] of sent.entries()) {
    assert.ok(payload.text.length <= 3500); assertSafeLines(payload.text);
    assert.equal(payload.parse_mode, "HTML");
    assert.equal(payload.chat_id, "42"); assert.equal(payload.link_preview_options.is_disabled, true);
    assert.equal(!!payload.reply_markup, index === 0);
  }
  await sendTelegramMessage("123:test", "42", "Legacy <text>");
  assert.equal(sent.at(-1).text, "Legacy <text>"); assert.equal(sent.at(-1).parse_mode, undefined);
});

test("notification bounds survive very long escaped labels and Unicode without invalid HTML", async (t) => {
  const sent: any[] = [];
  t.mock.method(globalThis, "fetch", async (_input: any, init: any) => {
    sent.push(JSON.parse(init.body)); return Response.json({ ok: true });
  });
  const card = notificationCard('"'.repeat(2000), [{ label: '"'.repeat(2000), value: '"'.repeat(2000) }, { label: "x" + "🟡".repeat(2000), value: "\ud800 text" }, "🟡".repeat(2000)]);
  await sendTelegramMessage("123:test", "42", card);
  for (const payload of sent) { assertSafeLines(payload.text); assert.ok(payload.text.isWellFormed()); }
});

test("sender rejects Telegram failures without leaking credentials", async (t) => {
  const previous = process.env.JUPITER_API_KEY;
  process.env.JUPITER_API_KEY = "notification-secret";
  t.after(() => { if (previous === undefined) delete process.env.JUPITER_API_KEY; else process.env.JUPITER_API_KEY = previous; });
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, description: "x-api-key: notification-secret" }));
  await assert.rejects(sendTelegramMessage("123:test", "42", "test"), (error: any) => {
    assert.doesNotMatch(error.message, /notification-secret/); return true;
  });
});

function agentHarness(t: any) {
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const config = parseConfig(readFileSync("config.example.json", "utf8"));
  const agent = new YolowAgent({ db, config, connection: { getBalance: async () => 1000000000 } as any,
    wallet: new PublicKey(key(70)), telegramToken: "123:test", chatId: "42", jupiterApiKey: "test" });
  const sent: any[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    if (String(input).includes("/tokens/v2/search")) return Response.json([{ id: key(73), symbol: "<NEW>", name: "New & Coin" }]);
    assert.match(String(input), /\/sendMessage$/); sent.push(JSON.parse(init.body)); return Response.json({ ok: true });
  });
  return { db, config, agent, sent };
}

test("discovery sends distinct new/missing position cards with metadata, mode and useful buttons", async (t) => {
  const h = agentHarness(t);
  const insert = (id: string, mint: string) => h.db.prepare(`INSERT INTO positions
    (id,pool,token_mint,quote_mint,lower_bin_id,upper_bin_id,first_seen_at,last_checked,bin_step,base_fee_percent)
    VALUES(?,?,?,?,0,20,1,1,80,0.3)`).run(id, key(72), mint, "So11111111111111111111111111111111111111112");
  insert(key(71), key(74));
  t.mock.method(h.agent.executor, "reconcileTransactions", async () => {
    h.db.prepare("UPDATE positions SET state='CLOSED'").run(); insert(key(75), key(73));
  });
  t.mock.method((h.agent as any).activeBins, "refreshPools", async () => {});
  await (h.agent as any).discover();
  assert.equal(h.sent.length, 2);
  const [added, removed] = h.sent;
  assert.match(added.text, /POSISI BARU TERDETEKSI/); assert.match(added.text, /&lt;NEW&gt;/);
  assert.match(added.text, /DRY-RUN/); assert.match(added.text, /80/); assert.match(added.text, /0,30%/);
  assert.ok(added.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === `position:view:${key(75)}`));
  assert.match(removed.text, /POSISI TIDAK LAGI DI WALLET/); assert.match(removed.text, /Pemantauan dihentikan/);
  assert.ok(removed.text.includes(key(71)));
  assert.ok(!removed.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data?.startsWith("position:view:")));
  for (const p of h.sent) { assertSafeLines(p.text); assert.equal(p.parse_mode, "HTML"); }
});

test("balance, heartbeat and backup failures share the safe card renderer", async (t) => {
  const h = agentHarness(t);
  t.mock.method((h.agent as any).options.connection, "getBalance", async () => 0);
  await (h.agent as any).checkLowSolBalance();
  t.mock.method((h.agent as any).options.connection, "getBalance", async () => 1000000000);
  await (h.agent as any).checkLowSolBalance();
  await (h.agent as any).heartbeat();
  h.config.history.backup.dir = "\0invalid";
  t.mock.method(console, "error", () => {});
  await (h.agent as any).backup();
  assert.equal(h.sent.length, 4);
  for (const title of ["SALDO SOL RENDAH", "SALDO SOL KEMBALI NORMAL", "RINGKASAN HARIAN", "BACKUP DATABASE GAGAL"]) {
    const p = h.sent.find((p) => p.text.includes(title)); assert.ok(p); assertSafeLines(p.text);
    assert.equal(p.parse_mode, "HTML"); assert.match(p.text, /DRY-RUN/);
  }
});
