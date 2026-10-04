import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { parseConfig } from "../src/config/config.ts";
import { applyConfigInPlace, configUpdateNeedsRestart, prepareConfigUpdate, writeConfigAtomically } from "../src/config/config-store.ts";
import { createCommandHandler } from "../src/telegram/commands.ts";
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
