const secretEnvNames = ["TELEGRAM_BOT_TOKEN", "HELIUS_API_KEY", "JUPITER_API_KEY", "GMGN_API_KEY"];

export function redactSecrets(value: string): string {
  let message = value;
  for (const name of secretEnvNames) {
    const secret = process.env[name]?.trim();
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,"']+/gi, "$1=[redacted]")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/\b((?:x[-_])?(?:api[\s_-]?key|access[\s_-]?token|token|secret|password))\s*[:=]\s*["']?[^\s,"'&]+/gi, "$1=[redacted]");
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  return redactSecrets(message)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 500);
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function telegramApiBase(token: string): string {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("TELEGRAM_BOT_TOKEN format is invalid");
  return `https://api.telegram.org/bot${token}`;
}

export async function readJsonResponse<T>(response: Response, maxBytes = 2_000_000): Promise<T> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Respons API melewati batas ukuran");
  }
  if (!response.body) throw new Error("Respons API tidak memiliki body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Respons API melewati batas ukuran");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
