import assert from "node:assert/strict";
import test from "node:test";
import { actionForMessage } from "../src/telegram/bot.ts";

test("Menu and Top Trending buttons route to their actions and commands remain available", () => {
  assert.equal(actionForMessage("Menu"), "menu");
  assert.equal(actionForMessage("/menu@yolow_bot"), "menu");
  assert.equal(actionForMessage("/start"), "start");
  assert.equal(actionForMessage("Top Trending"), "top_trending");
  assert.equal(actionForMessage("/toptrending"), "top_trending");
  assert.equal(actionForMessage("/unknown"), undefined);
});
