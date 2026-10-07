import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import DLMM from "../src/meteora.ts";
import { parseConfig } from "../src/config/config.ts";
import { applyConfigInPlace, configUpdateNeedsRestart, prepareConfigUpdate, writeConfigAtomically } from "../src/config/config-store.ts";
import { createCommandHandler } from "../src/telegram/commands.ts";
import { binStepLabel } from "../src/telegram/presentation.ts";
import { openDatabase } from "../src/storage/db.ts";

async function exampleConfig() {
  return parseConfig(await readFile("config.example.json", "utf8"));
}

test("config editor validates values and leaves the running config untouched until applied", async () => {
  const current = await exampleConfig();
  const update = prepareConfigUpdate(current, "oor_exit.below.trigger_bins", "24");
  assert.equal(current.oor_exit.below.trigger_bins, 20);
  assert.equal(update.config.oor_exit.below.trigger_bins, 24);
  assert.equal(update.oldValue, 20);
  assert.equal(update.newValue, 24);
  assert.throws(() => prepareConfigUpdate(current, "oor_exit.below.trigger_bins", "0"), /must be a number >= 1/);
  assert.equal(prepareConfigUpdate(current, "top_trending.min_token_age_hours", "5").config.top_trending.min_token_age_hours, 5);
  assert.equal(prepareConfigUpdate(current, "top_trending.volume_window", "\"4h\"").config.top_trending.volume_window, "4h");
  assert.throws(() => prepareConfigUpdate(current, "top_trending.volume_window", "\"6h\""), /volume_window/);
  assert.throws(() => prepareConfigUpdate(current, "mode.dry_run", "false"), /tidak dapat diubah/);
  assert.throws(() => prepareConfigUpdate(current, "mode.shadow_candles", "false"), /belum diterapkan/);
  assert.throws(() => prepareConfigUpdate(current, "rpc.http_base.api_key", "secret"), /Secret/);
  assert.throws(() => prepareConfigUpdate(current, "rpc.http_base", "https://rpc.example/?api-key=secret"), /credential/);
  assert.throws(() => prepareConfigUpdate(current, "rpc.http_base", "https://mainnet.helius-rpc.com"), /tidak dapat diubah/);
  assert.throws(() => prepareConfigUpdate(current, "jupiter.base_url", "https://attacker.example"), /tidak dapat diubah/);
  assert.throws(() => prepareConfigUpdate(current, "history.backup.dir", "/tmp/exfil"), /tidak dapat diubah/);
});

test("config endpoints pin credential-bearing APIs and reject embedded keys", async () => {
  const current = await exampleConfig();
  const maliciousHost = structuredClone(current);
  maliciousHost.jupiter.base_url = "https://attacker.example";
  assert.throws(() => parseConfig(JSON.stringify(maliciousHost)), /trusted api.jup.ag/);
  const embeddedKey = structuredClone(current);
  embeddedKey.rpc.http_base = "https://mainnet.helius-rpc.com/?api-key=do-not-store";
  assert.throws(() => parseConfig(JSON.stringify(embeddedKey)), /credential/);
  const secretField = structuredClone(current) as any;
  secretField.unknown = { jupiter_api_key: "do-not-store" };
  assert.throws(() => parseConfig(JSON.stringify(secretField)), /tidak boleh menyimpan API key/);
});

test("config editor supports pool overrides and keeps object references during hot apply", async () => {
  const current = await exampleConfig();
  const pool = "8bRqShHqwgZfrtqxK3bjE7Gu78Enm8iik5NTp3bfnf1E";
  const update = prepareConfigUpdate(current, `pool_overrides.${pool}.oor_exit.below.trigger_bins`, "28");
  assert.equal(update.config.pool_overrides[pool].oor_exit?.below?.trigger_bins, 28);
  const indicatorSettings = current.indicator_exit;
  const disabled = prepareConfigUpdate(current, "indicator_exit.enabled", "false");
  applyConfigInPlace(current, disabled.config);
  assert.equal(current.indicator_exit, indicatorSettings);
  assert.equal(current.indicator_exit.enabled, false);
});

test("config editor flags settings that need process restart", () => {
  assert.equal(configUpdateNeedsRestart("candles.poll_interval_sec"), true);
  assert.equal(configUpdateNeedsRestart("rpc.http_base"), true);
  assert.equal(configUpdateNeedsRestart("oor_exit.below.trigger_bins"), false);
});

test("config file is atomically replaced with validated JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yolow-config-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, "old", "utf8");
    await writeConfigAtomically(path, "{\n  \"saved\": true\n}\n");
    assert.equal(await readFile(path, "utf8"), "{\n  \"saved\": true\n}\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Telegram /config set persists, hot-applies, and audits a validated setting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yolow-telegram-config-"));
  const path = join(directory, "config.json");
  const config = await exampleConfig();
  const db = openDatabase(":memory:");
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const handler = createCommandHandler({
      agent: { executor: { isDryRun: () => true }, getTimeframe: () => "15m" } as any,
      db, connection: {} as any, wallet: new PublicKey("11111111111111111111111111111111"),
      telegramToken: "test", chatId: "test", configPath: path, jupiterApiKey: "test", config,
    });
    const menu = await handler.onCommand("/config", []);
    assert.match(menu?.text ?? "", /KONFIGURASI YOLOW/);
    assert.equal(menu?.replyMarkup?.inline_keyboard?.[0]?.[1]?.callback_data, "config:section:oor");
    const reply = await handler.onCommand("/config", ["set", "oor_exit.below.trigger_bins", "23"]);
    assert.match(reply?.text ?? "", /CONFIG DISIMPAN/);
    assert.equal(config.oor_exit.below.trigger_bins, 23);
    const saved = parseConfig(await readFile(path, "utf8"));
    assert.equal(saved.oor_exit.below.trigger_bins, 23);
    const audit = db.prepare("SELECT path,old_value,new_value FROM config_changes").get() as Record<string, string>;
    assert.equal(audit.path, "oor_exit.below.trigger_bins");
    assert.equal(audit.old_value, "20");
    assert.equal(audit.new_value, "23");
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Telegram config editor navigates sections, toggles booleans, sets presets, and accepts typed input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yolow-telegram-editor-"));
  const path = join(directory, "config.json");
  const config = await exampleConfig();
  const db = openDatabase(":memory:");
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const handler = createCommandHandler({
      agent: { executor: { isDryRun: () => true }, getTimeframe: () => "15m" } as any,
      db, connection: {} as any, wallet: new PublicKey("11111111111111111111111111111111"),
      telegramToken: "test", chatId: "test", configPath: path, jupiterApiKey: "test", config,
    });

    // Section view lists parameters as buttons.
    const section = await handler.onCallback("config:section:trending");
    const sectionButtons = (section?.replyMarkup?.inline_keyboard as any[][]).flat();
    assert.ok(sectionButtons.some((button) => button.callback_data === "config:edit:top_trending.volume_window"));

    // Editor shows the current value and window presets.
    const editor = await handler.onCallback("config:edit:top_trending.volume_window");
    assert.match(editor?.text ?? "", /top_trending\.volume_window/);
    assert.match(editor?.text ?? "", /24h/);
    assert.equal(editor?.parseMode, "HTML");
    const presets = (editor?.replyMarkup?.inline_keyboard as any[][]).flat()
      .filter((button) => button.callback_data.startsWith("config:set:top_trending.volume_window:"));
    assert.deepEqual(presets.map((button) => button.callback_data.split(":").at(-1)), ["4h", "12h", "24h"]);

    // Tapping a preset persists, hot-applies, and audits.
    const applied = await handler.onCallback("config:set:top_trending.volume_window:4h");
    assert.match(applied?.text ?? "", /CONFIG DISIMPAN/);
    assert.equal(config.top_trending.volume_window, "4h");
    assert.equal(parseConfig(await readFile(path, "utf8")).top_trending.volume_window, "4h");
    const audit = db.prepare("SELECT path,old_value,new_value FROM config_changes ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
    assert.equal(audit.path, "top_trending.volume_window");
    assert.equal(audit.old_value, "\"24h\"");
    assert.equal(audit.new_value, "\"4h\"");

    // Boolean toggle applies immediately.
    const toggled = await handler.onCallback("config:set:top_trending.enabled:false");
    assert.match(toggled?.text ?? "", /CONFIG DISIMPAN/);
    assert.equal(config.top_trending.enabled, false);

    // Typed input flow: request input, then send the raw value as a message.
    const inputPrompt = await handler.onCallback("config:input:top_trending.min_holders");
    assert.match(inputPrompt?.text ?? "", /KIRIM NILAI BARU/);
    const typed = await handler.onText("2500");
    assert.match(typed?.text ?? "", /CONFIG DISIMPAN/);
    assert.equal(config.top_trending.min_holders, 2500);
    assert.equal(parseConfig(await readFile(path, "utf8")).top_trending.min_holders, 2500);

    // Typing "batal" cancels the pending input without changing anything.
    await handler.onCallback("config:input:top_trending.min_holders");
    const cancelled = await handler.onText("batal");
    assert.match(cancelled?.text ?? "", /dibatalkan/);
    assert.equal(config.top_trending.min_holders, 2500);

    // Menu navigation is not swallowed, and abandons the pending input so stray text is ignored.
    await handler.onCallback("config:input:top_trending.min_holders");
    assert.equal(await handler.onText("Menu"), undefined);
    assert.equal(await handler.onText("/status"), undefined);
    assert.equal(await handler.onText("9999"), undefined);
    assert.equal(config.top_trending.min_holders, 2500);

    // The cancel button clears the pending input as well.
    const prompt = await handler.onCallback("config:input:top_trending.min_holders");
    assert.equal((prompt?.replyMarkup?.inline_keyboard as any[][])[0][0].callback_data, "config:cancel");
    const cancelButton = await handler.onCallback("config:cancel");
    assert.match(cancelButton?.text ?? "", /dibatalkan/);
    assert.equal(await handler.onText("7777"), undefined);
    assert.equal(config.top_trending.min_holders, 2500);

    // Invalid typed values keep the running config untouched.
    await handler.onCallback("config:input:top_trending.min_holders");
    const invalid = await handler.onText("\"bukan angka\"");
    assert.match(invalid?.text ?? "", /CONFIG TIDAK DIUBAH/);
    assert.equal(config.top_trending.min_holders, 2500);

    // Non-editable paths are rejected before an editor opens.
    assert.match((await handler.onCallback("config:edit:mode.dry_run"))?.text ?? "", /tidak dapat diubah/);
    assert.match((await handler.onCallback("config:input:mode.dry_run"))?.text ?? "", /tidak dapat diubah/);
    assert.match((await handler.onCallback("config:set:mode.dry_run:false"))?.text ?? "", /CONFIG TIDAK DIUBAH/);

    // Navigating away from the input prompt cancels the pending input.
    await handler.onCallback("config:input:top_trending.min_holders");
    await handler.onCallback("config:section:trending");
    assert.equal(await handler.onText("9999"), undefined);
    assert.equal(config.top_trending.min_holders, 2500);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Telegram /positions explains range distance and labels paused exit signals clearly", async () => {
  const config = await exampleConfig();
  const db = openDatabase(":memory:");
  const id = "AiEkQGg5thkPRXG4VPSyfoKCXJDbPi8P9fKMFuutuyn1";
  const pool = "4s2bzyM1CStvWCUC1r1q8Maoj6UmkqnBqnwBEFtDtpko";
  db.prepare(`INSERT INTO positions
    (id,pool,token_mint,quote_mint,bin_step,base_fee_percent,lower_bin_id,upper_bin_id,first_seen_at,state,active_bin,last_checked)
    VALUES(?,?,?,?,?,?,?,?,?,'OPEN',?,?)`)
    .run(id, pool, "BXoHJ123456789ABCDEFGHJKLMNPQRSTUVWXYZkpump", "So11111111111111111111111111111111111111112", 25, 2, -483, -321, Date.UTC(2026, 9, 4), -358, Date.now());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/tokens/v2/search");
    assert.equal(url.searchParams.get("query"), "BXoHJ123456789ABCDEFGHJKLMNPQRSTUVWXYZkpump");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-jupiter-key");
    return new Response(JSON.stringify([{ id: "BXoHJ123456789ABCDEFGHJKLMNPQRSTUVWXYZkpump", symbol: "BONK", name: "<b>Bonk</b>" }]), { status: 200 });
  }) as typeof fetch;
  const handler = createCommandHandler({
    agent: { executor: { isDryRun: () => true }, getTimeframe: () => "15m" } as any,
    db, connection: {} as any, wallet: new PublicKey("11111111111111111111111111111111"),
    telegramToken: "test", chatId: "test", config, jupiterApiKey: "test-jupiter-key",
  });

  try {
    const initial = await handler.onCommand("/positions", []);
    assert.match(initial?.text ?? "", /📍 <b>POSISI TERBUKA<\/b> · 1/);
    assert.match(initial?.text ?? "", /🪙 Token <b>BONK · &lt;b&gt;Bonk&lt;\/b&gt;<\/b>/);
    assert.match(initial?.text ?? "", /🧭 Bin step 25 · Fee 2%/);
    assert.match(initial?.text ?? "", /Dalam range · 125 bin dari batas bawah · 37 bin dari batas atas/);
    assert.match(initial?.text ?? "", /Sinyal terakhir: Belum ada sinyal exit/);
    assert.ok((initial?.text ?? "").includes(`🪙 Posisi <code>${id}</code>`));
    assert.ok((initial?.text ?? "").includes(`💧 Pool <code>${pool}</code>`));
    assert.equal(initial?.parseMode, "HTML");
    assert.equal(initial?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "⏸ Abaikan exit");

    const menuPositions = await handler.onCallback("cmd:/positions");
    assert.match(menuPositions?.text ?? "", /📍 <b>POSISI TERBUKA<\/b> · 1/);
    assert.match((await handler.onCallback("cmd:/ignore"))?.text ?? "", /tekan ⏸ Abaikan exit/);

    const ignored = await handler.onCommand("/ignore", [id]);
    assert.match(ignored?.text ?? "", /Data posisi tetap diperbarui, tetapi sinyal exit tidak akan dieksekusi/);
    const paused = await handler.onCommand("/positions", []);
    assert.match(paused?.text ?? "", /⏸ <b>SINYAL EXIT DIABAIKAN<\/b>/);
    assert.equal(paused?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "▶️ Aktifkan exit");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("database adds pool metadata to an existing positions table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yolow-bin-step-migration-"));
  const path = join(directory, "legacy.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE positions (
    id TEXT PRIMARY KEY, pool TEXT NOT NULL, token_mint TEXT NOT NULL, quote_mint TEXT NOT NULL,
    lower_bin_id INTEGER NOT NULL, upper_bin_id INTEGER NOT NULL, first_seen_at INTEGER NOT NULL,
    ignored INTEGER NOT NULL DEFAULT 0, ignore_updated_at INTEGER, state TEXT NOT NULL DEFAULT 'OPEN',
    active_bin INTEGER, last_checked INTEGER NOT NULL, closed_at INTEGER
  )`);
  legacy.close();
  try {
    const db = openDatabase(path);
    try {
      const columns = db.prepare("PRAGMA table_info(positions)").all() as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === "bin_step"));
      assert.ok(columns.some((column) => column.name === "base_fee_percent"));
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Meteora bin step and base fee are separate values", () => {
  const fee = DLMM.calculateFeeInfo(20_000, 100, 0).baseFeeRatePercentage;
  assert.equal(fee.toString(), "2");
  assert.equal(binStepLabel(100, Number(fee.toString())), "100 · Fee 2%");
});
