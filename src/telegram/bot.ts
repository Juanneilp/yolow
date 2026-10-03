import { fetchTopTrending, formatTopTrending, type TopTrendingConfig } from "../market-data/top-trending.ts";

type BotOptions = {
  token: string;
  chatId: string;
  config: TopTrendingConfig;
  jupiterApiKey: string;
  gmgnApiKey?: string;
  meteoraBaseUrl: string;
  jupiterTokensBaseUrl: string;
};

export function actionForMessage(text: string): "menu" | "start" | "top_trending" | undefined {
  const messageText = text.trim();
  const command = messageText.split(/\s+/)[0]?.split("@")[0];
  if (messageText === "Menu" || command === "/menu") return "menu";
  if (command === "/start") return "start";
  if (command === "/toptrending" || messageText === "Top Trending") return "top_trending";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBot(options: BotOptions): Promise<void> {
  const api = `https://api.telegram.org/bot${options.token}`;
  let offset = 0;

  async function telegram(method: string, body: Record<string, unknown>): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${api}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000),
      });
    } catch {
      throw new Error(`Telegram ${method} request failed or timed out`);
    }
    if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
    const result = await response.json() as { ok?: boolean; result?: any; description?: string };
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

  async function showTopTrending(): Promise<void> {
    const tokens = await fetchTopTrending(
      options.config,
      options.jupiterApiKey,
      options.meteoraBaseUrl,
      options.jupiterTokensBaseUrl,
      options.gmgnApiKey,
    );
    await send(formatTopTrending(tokens, options.config), undefined, "HTML");
  }

  const menu = {
    keyboard: [[{ text: "Menu" }, { text: "Top Trending" }]],
    resize_keyboard: true,
    is_persistent: true,
  };
  const menuText = "Perintah yang tersedia:\n/start — Tampilkan menu\n/menu — Lihat daftar perintah\n/toptrending — Lihat token trending";
  console.log("Yolow Phase 1 bot is polling Telegram.");

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      }) as any[];

      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message ?? update.callback_query?.message;
        if (String(message?.chat?.id ?? "") !== options.chatId) continue;

        try {
          if (update.callback_query) {
            await telegram("answerCallbackQuery", { callback_query_id: update.callback_query.id });
            if (update.callback_query.data === "top_trending") await showTopTrending();
            continue;
          }

          const action = actionForMessage(String(update.message?.text ?? ""));
          if (action === "menu") {
            await send(menuText, menu);
          } else if (action === "start") {
            await send("⚡ Yolow · Meteora DLMM\nPilih fitur:", menu);
          } else if (action === "top_trending") {
            await showTopTrending();
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : "unknown error";
          console.error("Telegram update failed:", reason);
          await send(`Yolow gagal memproses permintaan: ${reason}`).catch(() => undefined);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error("Telegram polling failed:", reason);
      await wait(3_000);
    }
  }
}
