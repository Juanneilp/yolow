export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const api = `https://api.telegram.org/bot${token}/sendMessage`;
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
    const response = await fetch(api, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Telegram sendMessage returned HTTP ${response.status}`);
    const result = await response.json() as { ok?: boolean; description?: string };
    if (!result.ok) throw new Error(`Telegram sendMessage failed: ${result.description ?? "unknown error"}`);
  }
}
