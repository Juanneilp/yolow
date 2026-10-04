import { readJsonResponse, safeError, telegramApiBase } from "../security.ts";

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const api = `${telegramApiBase(token)}/sendMessage`;
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > 3_500) {
      chunks.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line}`;
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) {
    let response: Response;
    try {
      response = await fetch(api, {
        method: "POST", headers: { "content-type": "application/json" },
        redirect: "error",
        body: JSON.stringify({ chat_id: chatId, text: chunk }), signal: AbortSignal.timeout(15_000),
      });
    } catch (error) { throw new Error(safeError(error)); }
    if (!response.ok) throw new Error(`Telegram sendMessage returned HTTP ${response.status}`);
    const result = await readJsonResponse<{ ok?: boolean; description?: string }>(response, 1_000_000);
    if (!result.ok) throw new Error(`Telegram sendMessage failed: ${safeError(result.description ?? "unknown error")}`);
  }
}
