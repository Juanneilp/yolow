import assert from "node:assert/strict";
import test from "node:test";
import { actionForMessage, mainMenuMarkup } from "../src/telegram/bot.ts";

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
  assert.deepEqual(rows.slice(0, 3).map((row) => row.length), [2, 2, 2]);
  assert.equal(rows[3][0].callback_data, "top_trending");
  assert.equal(rows[3][1].callback_data, "cmd:/config");
  assert.equal(rows[4][0].callback_data, "help");
});
