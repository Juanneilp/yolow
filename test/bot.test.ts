import assert from "node:assert/strict";
import test from "node:test";
import { actionForMessage, isAuthorizedUpdate, mainMenuMarkup } from "../src/telegram/bot.ts";

test("persistent button labels and slash commands route to menu actions", () => {
  assert.equal(actionForMessage("Menu"), "menu");
  assert.equal(actionForMessage("🏠 Menu"), "menu");
  assert.equal(actionForMessage("/menu@yolow_bot"), "menu");
  assert.equal(actionForMessage("/start"), "start");
  assert.equal(actionForMessage("Top Trending"), "top_trending");
  assert.equal(actionForMessage("🔥 Top Trending"), "top_trending");
  assert.equal(actionForMessage("/toptrending"), "top_trending");
  assert.equal(actionForMessage("/unknown"), undefined);
});

test("inline home menu groups features into a two-column grid", () => {
  const rows = mainMenuMarkup.inline_keyboard;
  assert.ok(rows.every((row) => row.length === 2));
  const commands = new Set(rows.flat().map((button) => button.callback_data));
  for (const command of ["/status", "/positions", "/history", "/stats", "/tf", "/export", "/config", "/ignore", "/unignore", "/trade", "/retryswap", "/note", "/tag", "/golive"]) {
    assert.ok(commands.has(`cmd:${command}`), `menu is missing ${command}`);
  }
  assert.ok(commands.has("top_trending"));
  assert.ok(commands.has("help"));
});

test("commands and callbacks require both the configured chat and allowed sender", () => {
  const message = { message: { chat: { id: -100 }, from: { id: 42 }, text: "/golive" } };
  assert.equal(isAuthorizedUpdate(message, "-100", "42"), true);
  assert.equal(isAuthorizedUpdate(message, "-100", "43"), false);
  assert.equal(isAuthorizedUpdate(message, "-101", "42"), false);
  assert.equal(isAuthorizedUpdate({ callback_query: { message: message.message, from: { id: 43 } } }, "-100", "42"), false);
});
