import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const fields = ["trade_id", "mode", "position_id", "pool", "pair", "token_mint", "bin_step", "shape_inferred", "tags", "notes",
  "opened_at", "first_seen_at", "entry_source", "initial_sol_capital", "lower_bin", "upper_bin", "entry_active_bin",
  "entry_price_sol", "entry_price_usd", "entry_market_cap_usd", "entry_sol_usd", "exit_at", "trigger_reason", "trigger_detail",
  "exit_active_bin", "exit_price_sol", "exit_price_usd", "exit_market_cap_usd", "close_signature", "sol_received", "tokens_received",
  "network_fees_sol", "swap_status", "swap_signature", "swap_input_mint", "swap_sol_received", "swap_slippage", "swap_price_impact",
  "remaining_dust_usd", "total_sol_returned", "pnl_sol", "pnl_pct", "pnl_usd", "pnl_reason", "duration_sec", "time_in_range_pct",
  "mfe_sol", "mae_sol", "max_drawdown_pct", "max_active_bin", "min_active_bin", "range_exit_count", "manual_changes_detected", "finalized_at"] as const;
const timeFields = new Set(["opened_at", "first_seen_at", "exit_at", "finalized_at"]);
const postExitOffsets = [15, 60, 240, 1440];

function quoteCsv(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function wibCsv(epoch: unknown, timezone: string): string {
  if (typeof epoch !== "number") return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(epoch));
}

export function tradesCsv(db: DatabaseSync, timezone: string, offsets = postExitOffsets): string {
  const rows = db.prepare("SELECT * FROM trade_history ORDER BY trade_id").all() as Array<Record<string, unknown>>;
  const columns = [...fields, ...offsets.map((offset) => `post_exit_${offset}m_pct`)];
  const headers = columns.map((field) => timeFields.has(field) ? `${field.replaceAll("_", " ")} (WIB)` : field);
  const markQuery = db.prepare("SELECT offset_min,percent_vs_exit FROM post_exit_marks WHERE trade_id=?");
  return [headers.map(quoteCsv).join(","), ...rows.map((row) => {
    const marks = new Map((markQuery.all(row.trade_id as number) as Array<{ offset_min: number; percent_vs_exit: number | null }>)
      .map((mark) => [mark.offset_min, mark.percent_vs_exit]));
    return columns.map((field) => {
      if (timeFields.has(field)) return quoteCsv(wibCsv(row[field], timezone));
      const postOffset = /^post_exit_(\d+)m_pct$/.exec(field);
      if (postOffset) return quoteCsv(marks.get(Number(postOffset[1])));
      return quoteCsv(row[field]);
    }).join(",");
  })].join("\r\n");
}

export async function writeTradesCsv(db: DatabaseSync, path: string, timezone: string, offsets = postExitOffsets): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, tradesCsv(db, timezone, offsets), "utf8");
}

export async function sendTelegramDocument(token: string, chatId: string, filename: string, contents: string): Promise<void> {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("document", new Blob([contents], { type: "text/csv" }), filename);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Telegram sendDocument returned HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!result.ok) throw new Error(`Telegram sendDocument failed: ${result.description ?? "unknown error"}`);
}

export async function persistTradeCsv(db: DatabaseSync, timezone: string, path: string, offsets = postExitOffsets): Promise<void> {
  try { await writeTradesCsv(db, path, timezone, offsets); }
  catch (error) { console.error("CSV export failed:", error instanceof Error ? error.message : "unknown error"); }
}
