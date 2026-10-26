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
  assert.equal(actionForMessage("📍 Posisi & PnL"), "positions");
  assert.equal(actionForMessage("Posisi & PnL"), "positions");
  assert.equal(actionForMessage("🧪 Top Careless"), "top_careless");
  assert.equal(actionForMessage("Top Careless"), "top_careless");
  assert.equal(actionForMessage("/unknown"), undefined);
});

test("start replaces the persistent keyboard and position and Careless shortcuts use existing handlers", async (t) => {
  const shutdown = new AbortController();
  const calls: Array<{ method: string; body: any }> = [];
  const commands: string[] = [];
  let polls = 0;
  const message = { chat: { id: 42 }, from: { id: 42 }, message_id: 1 };
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
    const method = new URL(input).pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "getUpdates") {
      if (++polls === 2) { shutdown.abort(); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: [
        { update_id: 1, message: { ...message, text: "/start" } },
        { update_id: 2, message: { ...message, text: "📍 Posisi & PnL" } },
        { update_id: 3, message: { ...message, text: "Posisi & PnL" } },
        { update_id: 4, message: { ...message, from: { id: 99 }, text: "📍 Posisi & PnL" } },
        { update_id: 5, message: { ...message, text: "🏠 Menu" } },
        { update_id: 6, message: { ...message, text: "🧪 Top Careless" } },
        { update_id: 7, message: { ...message, text: "Top Careless" } },
        { update_id: 8, message: { ...message, from: { id: 99 }, text: "🧪 Top Careless" } },
      ] });
    }
    assert.ok(["setMyCommands", "setChatMenuButton", "sendMessage"].includes(method));
    return Response.json({ ok: true, result: true });
  });
  await runBot({
    token: "123:test", chatId: "42",
    signal: shutdown.signal, onCommand: async (command, args) => {
      commands.push(command);
      assert.deepEqual(args, []);
      return { text: command === "/positions" ? "📍 POSISI & PnL" : command === "/topcareless" ? "🧪 TOP CARELESS STRAT" : "Status", parseMode: "HTML",
        replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: command === "/topcareless" ? "cmd:/topcareless" : "positions:refresh:0" }]] } };
    },
  });
  assert.deepEqual(commands, ["/status", "/positions", "/positions", "/status", "/topcareless", "/topcareless"]);
  const replies = calls.filter(({ method }) => method === "sendMessage").map(({ body }) => body);
  assert.equal(replies.length, 6);
  assert.deepEqual(replies[0].reply_markup.keyboard, [[{ text: "🏠 Menu" }, { text: "📍 Posisi & PnL" }], [{ text: "🧪 Top Careless" }]]);
  assert.equal(replies[0].reply_markup.is_persistent, true);
  for (const reply of replies.slice(1, 3)) {
    assert.equal(reply.text, "📍 POSISI & PnL");
    assert.equal(reply.parse_mode, "HTML");
    assert.equal(reply.reply_markup.inline_keyboard[0][0].callback_data, "positions:refresh:0");
  }
  assert.deepEqual(replies[3].reply_markup, mainMenuMarkup);
  for (const reply of replies.slice(4)) {
    assert.equal(reply.text, "🧪 TOP CARELESS STRAT");
    assert.equal(reply.parse_mode, "HTML");
    assert.equal(reply.reply_markup.inline_keyboard[0][0].callback_data, "cmd:/topcareless");
  }
});

test("inline home menu groups features into a two-column grid", () => {
  const rows = mainMenuMarkup.inline_keyboard;
  assert.ok(rows.every((row) => row.length >= 1 && row.length <= 2));
  const commands = new Set(rows.flat().map((button) => button.callback_data));
  assert.deepEqual([...commands], ["cmd:/status", "cmd:/positions", "cmd:/topcareless", "cmd:/history", "cmd:/config", "help"]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.map(({ text }) => text)), [
    ["📊 Status", "📍 Posisi & PnL"], ["🧪 Top Careless", "📒 Jurnal"], ["⚙️ Pengaturan", "🧰 Bantuan"],
  ]);
});

test("commands and callbacks require both the configured chat and allowed sender", () => {
  const message = { message: { chat: { id: -100 }, from: { id: 42 }, text: "/golive" } };
  assert.equal(isAuthorizedUpdate(message, "-100", "42"), true);
  assert.equal(isAuthorizedUpdate(message, "-100", "43"), false);
  assert.equal(isAuthorizedUpdate(message, "-101", "42"), false);
  assert.equal(isAuthorizedUpdate({ callback_query: { message: message.message, from: { id: 43 } } }, "-100", "42"), false);
});

test("native command list includes eight primary commands with valid names and descriptions", () => {
  const expected = ["start", "menu", "status", "positions", "topcareless", "history", "config", "help"];
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
      token: "123:test", chatId: "42",
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
      for (const command of ["stats", "auto", "blacklist", "export", "ignore", "unignore", "trade", "note", "tag", "retryswap", "golive", "pnl"]) {
        assert.ok(body.text.includes(`/${command}`), `help is missing /${command}`);
      }
      for (const group of ["Pemantauan", "Screening", "Jurnal", "Pengaturan"]) assert.ok(body.text.includes(group));
      assert.doesNotMatch(body.text, /toptrending|Top Trending/);
      assert.ok(body.text.length < 3500);
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
    token: "123:test", chatId: "-100", userId: "42",
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
    token: "123:test", chatId: "42",
    signal: shutdown.signal, onCallback: async () => ({
      text: "Posisi & PnL +0.00063144 SOL", replyMarkup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "positions:refresh:0" }]] },
    }),
  });
  const editCalls = calls.filter(({ method }) => method === "editMessageText");
  assert.equal(editCalls.length, 3);
  assert.ok(editCalls.every(({ body }) => body.link_preview_options?.is_disabled === true));
  assert.ok(editCalls.every(({ body }) => body.chat_id === 42 && body.message_id === 123));
  assert.equal(calls.filter(({ method }) => method === "sendMessage").length, 0);
});

test("old Trending commands and buttons show removal notice without discovery requests", async (t) => {
  const shutdown = new AbortController();
  const calls: Array<{ method: string; body: any }> = [];
  const message = { chat: { id: 42 }, from: { id: 42 }, message_id: 123 };
  const callbacks: string[] = [];
  let polls = 0;
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.telegram.org");
    const method = url.pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "getUpdates") {
      if (++polls > 1) { shutdown.abort(); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: [
        ...["/toptrending", "/toptrending@yolow_bot", "Top Trending", "🔥 Top Trending"].map((text, i) =>
          ({ update_id: i + 1, message: { ...message, text } })),
        ...["top_trending", "config:section:trending", "cmd:/toptrending"].map((data, i) =>
          ({ update_id: i + 5, callback_query: { id: String(i), from: message.from, message, data } })),
        { update_id: 8, message: { ...message, from: { id: 99 }, text: "/toptrending" } },
        { update_id: 9, callback_query: { id: "unauthorized", from: { id: 99 }, message, data: "top_trending" } },
      ] });
    }
    return Response.json({ ok: true, result: true });
  });
  await runBot({ token: "123:test", chatId: "42", signal: shutdown.signal,
    onCommand: async () => { assert.fail("Trending must not reach a command handler"); },
    onCallback: async (data) => { callbacks.push(data); return undefined; },
  });
  const replies = calls.filter(({ method }) => ["sendMessage", "editMessageText"].includes(method));
  assert.equal(replies.length, 7);
  assert.equal(calls.filter(({ method }) => method === "answerCallbackQuery").length, 3);
  assert.deepEqual(callbacks, ["config:cancel", "config:cancel", "config:cancel"]);
  for (const { body } of replies) {
    assert.match(body.text, /Top Trending sudah dihapus/);
    assert.deepEqual(body.reply_markup, mainMenuMarkup);
  }
});
