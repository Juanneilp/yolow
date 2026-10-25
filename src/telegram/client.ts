import { readJsonResponse, safeError, telegramApiBase } from "../security.ts";

export type TelegramMessage = { text: string; parseMode?: "HTML"; replyMarkup?: Record<string, unknown> };
export type Notification = string | TelegramMessage;

export async function sendTelegramMessage(token: string, chatId: string, message: Notification): Promise<void> {
  const payload: TelegramMessage = typeof message === "string" ? { text: message } : message;
  const { text, parseMode, replyMarkup } = payload;
  const api = `${telegramApiBase(token)}/sendMessage`;
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.length > 3_500) throw new Error("Baris notifikasi melewati batas ukuran Telegram");
    if (current && current.length + line.length + 1 > 3_500) {
      chunks.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line}`;
  }
  if (current) chunks.push(current);
  for (const [index, chunk] of chunks.entries()) {
    let response: Response;
    try {
      response = await fetch(api, {
        method: "POST", headers: { "content-type": "application/json" },
        redirect: "error",
        body: JSON.stringify({ chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true },
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }), signal: AbortSignal.timeout(15_000),
      });
    } catch (error) { throw new Error(safeError(error)); }
    if (!response.ok) throw new Error(`Telegram sendMessage returned HTTP ${response.status}`);
    const result = await readJsonResponse<{ ok?: boolean; description?: string }>(response, 1_000_000);
    if (!result.ok) throw new Error(`Telegram sendMessage failed: ${safeError(result.description ?? "unknown error")}`);
  }
}
