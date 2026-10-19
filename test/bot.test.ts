import assert from "node:assert/strict";
import test from "node:test";
import { actionForMessage, botCommands, isAuthorizedUpdate, mainMenuMarkup, runBot } from "../src/telegram/bot.ts";

test("persistent button labels and slash commands route to menu actions", () => {
  assert.equal(actionForMessage("Menu"), "menu");
  assert.equal(actionForMessage("🏠 Menu"), "menu");
  assert.equal(actionForMessage("/menu@yolow_bot"), "menu");
  assert.equal(actionForMessage("/start"), "start");
  assert.equal(actionForMessage("/help"), "help");
  assert.equal(actionForMessage("/help@yolow_bot"), "help");
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
  assert.equal(commands.has("cmd:/pnl"), false);
  assert.equal(rows[0][1].text, "📍 Posisi & PnL");
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

test("native command list includes all supported commands with valid names and descriptions", () => {
  const expected = ["start", "menu", "help", "status", "positions", "history", "stats", "tf", "export", "toptrending", "config", "ignore", "unignore", "trade", "note", "tag", "retryswap", "golive"];
  assert.deepEqual(botCommands.map(({ command }) => command), expected);
  assert.equal(new Set(botCommands.map(({ command }) => command)).size, expected.length);
  for (const { command, description } of botCommands) {
    assert.match(command, /^[a-z0-9_]{1,32}$/);
    assert.ok(description.length >= 1 && description.length <= 256);
  }
});

for (const failure of [undefined, "setMyCommands", "setChatMenuButton"]) {
  test(`native command setup and help routing continue polling${failure ? ` when ${failure} fails` : ""}`, async (t) => {
    const shutdown = new AbortController();
    const calls: Array<{ method: string; body: any }> = [];
    let polls = 0;
    const message = { chat: { id: 42 }, from: { id: 42 }, message_id: 1 };
    const warn = t.mock.method(console, "warn", () => {});
    t.mock.method(console, "log", () => {});
    t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
      const method = new URL(input).pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init.body));
      calls.push({ method, body });
      if (method === failure) return Response.json({ ok: false, description: "test failure" }, { status: 400 });
      if (method === "getUpdates") {
        polls++;
        if (polls === 2) { shutdown.abort(); return Response.json({ ok: true, result: [] }); }
        return Response.json({ ok: true, result: [
          { update_id: 1, message: { ...message, text: "/help" } },
          { update_id: 2, message: { ...message, text: "/help@yolow_bot" } },
          { update_id: 3, callback_query: { id: "cb", from: message.from, message, data: "help" } },
          { update_id: 4, message: { ...message, from: { id: 99 }, text: "/help" } },
        ] });
      }
      assert.ok(["setMyCommands", "setChatMenuButton", "answerCallbackQuery", "sendMessage", "editMessageText"].includes(method));
      return Response.json({ ok: true, result: true });
    });
    await runBot({
      token: "123:test", chatId: "42", config: {} as any, jupiterApiKey: "",
      meteoraBaseUrl: "https://dlmm.datapi.meteora.ag", jupiterTokensBaseUrl: "https://api.jup.ag/tokens/v2",
      signal: shutdown.signal, onCommand: async () => { throw new Error("Help should be handled by the bot"); },
    });
    const registrations = calls.filter(({ method }) => method === "setMyCommands");
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0].body, { commands: botCommands, scope: { type: "chat", chat_id: "42" }, language_code: "" });
    const buttons = calls.filter(({ method }) => method === "setChatMenuButton");
    assert.equal(buttons.length, 1);
    assert.deepEqual(buttons[0].body, { chat_id: "42", menu_button: { type: "commands" } });
    assert.equal(polls, 2);
    assert.equal(warn.mock.callCount(), failure ? 1 : 0);
    const replies = calls.filter(({ method }) => method === "sendMessage" || method === "editMessageText");
    assert.equal(replies.length, 3);
    for (const { body } of replies) {
      assert.equal(body.text, replies[0].body.text);
      for (const { command, description } of botCommands) assert.ok(body.text.includes(`/${command} — ${description}`));
      assert.match(body.text, /\/trade <trade_id\|position_id>/);
      assert.deepEqual(body.reply_markup, mainMenuMarkup);
    }
  });
}

test("group chats register commands without calling the private-chat menu API", async (t) => {
  const shutdown = new AbortController();
  const methods: string[] = [];
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const method = new URL(input).pathname.split("/").at(-1)!;
    methods.push(method);
    if (method === "getUpdates") shutdown.abort();
    return Response.json({ ok: true, result: method === "getUpdates" ? [] : true });
  });
  await runBot({
    token: "123:test", chatId: "-100", userId: "42", config: {} as any, jupiterApiKey: "",
    meteoraBaseUrl: "https://dlmm.datapi.meteora.ag", jupiterTokensBaseUrl: "https://api.jup.ag/tokens/v2",
    signal: shutdown.signal,
  });
  assert.deepEqual(methods, ["setMyCommands", "getUpdates"]);
});

test("repeated PnL refresh edits the same bubble and ignores Telegram's unchanged-message response", async (t) => {
  const shutdown = new AbortController();
  const calls: Array<{ method: string; body: any }> = [];
  let polls = 0;
  let edits = 0;
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
    const method = new URL(input).pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "getUpdates") {
      if (++polls > 1) { shutdown.abort(); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: [1, 2, 3].map((n) => ({
        update_id: n, callback_query: {
          id: `refresh-${n}`, from: { id: 42 }, data: "positions:refresh:0",
          message: { chat: { id: 42 }, message_id: 123 },
        },
      })) });
    }
    if (method === "editMessageText" && ++edits > 1) {
      return Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 });
    }
    return Response.json({ ok: true, result: true });
  });
  await runBot({
    token: "123:test", chatId: "42", config: {} as any, jupiterApiKey: "",
    meteoraBaseUrl: "https://dlmm.datapi.meteora.ag", jupiterTokensBaseUrl: "https://api.jup.ag/tokens/v2",
    signal: shutdown.signal, onCallback: async () => ({
      text: "Posisi & PnL +0.00063144 SOL", replyMarkup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "positions:refresh:0" }]] },
    }),
  });
  const editCalls = calls.filter(({ method }) => method === "editMessageText");
  assert.equal(editCalls.length, 3);
  assert.ok(editCalls.every(({ body }) => body.chat_id === 42 && body.message_id === 123));
  assert.equal(calls.filter(({ method }) => method === "sendMessage").length, 0);
});
