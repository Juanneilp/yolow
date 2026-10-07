import { fetchTopTrending, formatTopTrending, type TopTrendingConfig } from "../market-data/top-trending.ts";
import { readJsonResponse, safeError, telegramApiBase } from "../security.ts";

type BotOptions = {
  token: string;
  chatId: string;
  userId?: string;
  config: TopTrendingConfig;
  trendingEnabled?: () => boolean;
  jupiterApiKey: string;
  gmgnApiKey?: string;
  meteoraBaseUrl: string;
  jupiterTokensBaseUrl: string;
  signal?: AbortSignal;
  onCommand?: (command: string, args: string[]) => Promise<{ text: string; replyMarkup?: Record<string, unknown>; parseMode?: "HTML" } | undefined>;
  onCallback?: (data: string) => Promise<{ text: string; replyMarkup?: Record<string, unknown>; parseMode?: "HTML" } | undefined>;
  onText?: (text: string) => Promise<{ text: string; replyMarkup?: Record<string, unknown>; parseMode?: "HTML" } | undefined>;
};

export function actionForMessage(text: string): "menu" | "start" | "top_trending" | undefined {
  const messageText = text.trim();
  const command = messageText.split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  const label = messageText.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
  if (label === "menu" || command === "/menu") return "menu";
  if (command === "/start") return "start";
  if (command === "/toptrending" || label === "top trending") return "top_trending";
}

export function isAuthorizedUpdate(update: any, chatId: string, userId = chatId): boolean {
  const message = update.message ?? update.callback_query?.message;
  const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
  return String(message?.chat?.id ?? "") === chatId && String(senderId ?? "") === userId;
}

export const mainMenuMarkup = { inline_keyboard: [
  [{ text: "📊 Status", callback_data: "cmd:/status" }, { text: "📍 Posisi", callback_data: "cmd:/positions" }],
  [{ text: "📒 Riwayat", callback_data: "cmd:/history" }, { text: "📈 Statistik", callback_data: "cmd:/stats" }],
  [{ text: "⏱ Timeframe", callback_data: "cmd:/tf" }, { text: "📤 Export CSV", callback_data: "cmd:/export" }],
  [{ text: "🔥 Top Trending", callback_data: "top_trending" }, { text: "⚙️ Konfigurasi", callback_data: "cmd:/config" }],
  [{ text: "⏸ Abaikan exit", callback_data: "cmd:/ignore" }, { text: "▶️ Aktifkan exit", callback_data: "cmd:/unignore" }],
  [{ text: "📖 Detail trade", callback_data: "cmd:/trade" }, { text: "🔁 Coba swap", callback_data: "cmd:/retryswap" }],
  [{ text: "📝 Catatan trade", callback_data: "cmd:/note" }, { text: "🏷 Tag trade", callback_data: "cmd:/tag" }],
  [{ text: "🔴 Live mode", callback_data: "cmd:/golive" }, { text: "🧰 Bantuan command", callback_data: "help" }],
] };

const quickAccessMarkup = {
  keyboard: [[{ text: "🏠 Menu" }, { text: "🔥 Top Trending" }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Pilih fitur Yolow",
};

function withMenuNavigation(markup?: Record<string, unknown>): Record<string, unknown> {
  if (!markup) return mainMenuMarkup;
  const rows = (markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard;
  if (!Array.isArray(rows)) return mainMenuMarkup;
  return { ...markup, inline_keyboard: [...rows, [{ text: "🏠 Menu", callback_data: "menu" }]] };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBot(options: BotOptions): Promise<void> {
  const api = telegramApiBase(options.token);
  let offset = 0;

  async function telegram(method: string, body: Record<string, unknown>): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${api}/${method}`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal
          ? AbortSignal.any([AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000), options.signal])
          : AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000),
      });
    } catch {
      throw new Error(`Telegram ${method} request failed or timed out`);
    }
    if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
    const result = await readJsonResponse<{ ok?: boolean; result?: any; description?: string }>(response, 1_000_000);
    if (!result.ok) throw new Error(`Telegram ${method} failed: ${result.description || "unknown error"}`);
    return result.result;
  }

  async function send(text: string, replyMarkup?: Record<string, unknown>, parseMode?: "HTML"): Promise<void> {
    const chunks: string[] = [];
    let current = "";
    for (const line of text.split("\n")) {
      if (current && current.length + line.length + 1 > 3_500) {
        chunks.push(current);
        current = "";
      }
      current += `${current ? "\n" : ""}${line}`;
    }
    if (current) chunks.push(current);
    for (const [index, chunk] of chunks.entries()) {
      await telegram("sendMessage", {
        chat_id: options.chatId,
        text: chunk,
        ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
    }
  }

  async function editOrSend(update: any, text: string, replyMarkup?: Record<string, unknown>, parseMode?: "HTML"): Promise<void> {
    const message = update.callback_query?.message;
    if (!message?.chat?.id || !message?.message_id || text.length > 3_500) {
      await send(text, replyMarkup, parseMode);
      return;
    }
    try {
      await telegram("editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("message is not modified")) return;
      await send(text, replyMarkup, parseMode);
    }
  }

  async function showTopTrending(update?: any): Promise<void> {
    if (options.trendingEnabled?.() === false) {
      const text = "🔥 TOP TRENDING\nFitur ini sedang dinonaktifkan di config.json.";
      if (update) await editOrSend(update, text, mainMenuMarkup);
      else await send(text, mainMenuMarkup);
      return;
    }
    const tokens = await fetchTopTrending(
      options.config,
      options.jupiterApiKey,
      options.meteoraBaseUrl,
      options.jupiterTokensBaseUrl,
      options.gmgnApiKey,
    );
    const text = formatTopTrending(tokens, options.config);
    const markup = {
      inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: "top_trending" }, { text: "⚙️ Filter", callback_data: "config:section:trending" }],
        [{ text: "🏠 Menu", callback_data: "menu" }],
      ],
    };
    if (update) await editOrSend(update, text, markup, "HTML");
    else await send(text, markup, "HTML");
  }

  async function showMenu(update?: any): Promise<void> {
    const status = await options.onCommand?.("/status", []);
    const text = `${status?.text ?? "⚡ YOLOW · METEORA DLMM"}\n\nPilih fitur:`;
    if (update) await editOrSend(update, text, mainMenuMarkup, status?.parseMode);
    else await send(text, mainMenuMarkup, status?.parseMode);
  }

  console.log("Yolow Telegram bot is polling.");

  while (!options.signal?.aborted) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        limit: 10,
        allowed_updates: ["message", "callback_query"],
      }) as any[];

      for (const update of updates) {
        offset = update.update_id + 1;
        if (!isAuthorizedUpdate(update, options.chatId, options.userId ?? options.chatId)) continue;

        try {
          if (update.callback_query) {
            await telegram("answerCallbackQuery", { callback_query_id: update.callback_query.id });
            if (update.callback_query.data === "top_trending") await showTopTrending(update);
            else if (update.callback_query.data === "menu") await showMenu(update);
            else if (update.callback_query.data === "help") {
              await editOrSend(update, "🧰 DAFTAR COMMAND\n/status · /positions · /history [1–50] · /stats [7d|30d|all]\n/tf [5m|15m|30m|1h] · /export · /toptrending · /config\n/config set <path> <nilai>\n/ignore <position_id> · /unignore <position_id>\n/trade <id|position_id> · /note <id|position_id> <catatan>\n/tag <id|position_id> <tag> · /retryswap <position_id>\n/golive · /menu · /start", mainMenuMarkup);
            } else if (options.onCallback) {
              const reply = await options.onCallback(String(update.callback_query.data ?? ""));
              if (reply) await editOrSend(update, reply.text, withMenuNavigation(reply.replyMarkup), reply.parseMode);
            }
            continue;
          }

          const messageText = String(update.message?.text ?? "");
          const isSlashCommand = messageText.trim().startsWith("/");
          if (!isSlashCommand && options.onText) {
            const pendingReply = await options.onText(messageText);
            if (pendingReply) {
              await send(pendingReply.text, withMenuNavigation(pendingReply.replyMarkup), pendingReply.parseMode);
              continue;
            }
          }
          const action = actionForMessage(messageText);
          if (action === "menu") {
            await showMenu();
          } else if (action === "start") {
            const status = await options.onCommand?.("/status", []);
            await send(status?.text ?? "⚡ YOLOW · METEORA DLMM\nPilih fitur melalui Menu.", quickAccessMarkup, status?.parseMode);
          } else if (action === "top_trending") {
            await showTopTrending();
          } else if (options.onCommand) {
            const [rawCommand = "", ...args] = messageText.trim().split(/\s+/);
            const command = rawCommand.split("@")[0];
            if (command.startsWith("/")) {
              const reply = await options.onCommand(command, args);
              if (reply) await send(reply.text, withMenuNavigation(reply.replyMarkup), reply.parseMode);
            }
          }
        } catch (error) {
          const reason = safeError(error);
          console.error("Telegram update failed:", reason);
          await send("Yolow gagal memproses permintaan. Periksa log server untuk detail.").catch(() => undefined);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      const reason = safeError(error);
      console.error("Telegram polling failed:", reason);
      await wait(3_000);
    }
  }
}
