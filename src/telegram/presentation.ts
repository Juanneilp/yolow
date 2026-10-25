import { escapeHtml, redactSecrets } from "../security.ts";
import type { TelegramMessage } from "./client.ts";

export type NotificationDetail = string | { label: string; value: string; code?: boolean };
export type NotificationCardOptions = {
  subtitle?: string; mode?: "DRY-RUN" | "LIVE"; timezone?: string; at?: number;
  positionId?: string; pool?: string; mint?: string; detailCallback?: string;
  action?: "positions" | "auto" | "history" | "config";
};

function notificationText(value: string): string {
  return escapeHtml([...redactSecrets(value).toWellFormed().replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, 500).join(""));
}

export function notificationTime(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone: timezone, day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(at));
}

export function notificationCard(title: string, details: NotificationDetail[], options: NotificationCardOptions = {}): TelegramMessage {
  const lines = [`<b>${notificationText(title)}</b>`];
  if (options.subtitle) lines.push(`<b>${notificationText(options.subtitle)}</b>`);
  if (options.mode) lines.push(options.mode === "DRY-RUN" ? "🟡 <b>DRY-RUN · SIMULASI</b>" : "🔴 <b>LIVE</b>");
  lines.push("", "━━━━━━━━━━━━━━━━━━", "");
  for (const detail of details) {
    if (typeof detail === "string") {
      // Split before escaping so each line remains independently valid HTML.
      lines.push(...redactSecrets(detail).split("\n").map(notificationText));
    } else {
      const label = notificationText([...detail.label].slice(0, 64).join("")), value = notificationText(detail.value);
      if (detail.code) lines.push(label, `<code>${value}</code>`);
      else lines.push(`${label}  <b>${value}</b>`);
    }
  }
  const addresses = [["Posisi", options.positionId], ["Pool", options.pool], ["CA", options.mint]].filter(([, value]) => value);
  if (addresses.length) lines.push("", ...addresses.flatMap(([label, value]) => [label!, `<code>${notificationText(value!)}</code>`]));
  if (options.timezone) lines.push("", `🕒 ${notificationTime(options.at ?? Date.now(), options.timezone)}`);
  const actions = {
    positions: ["📍 Posisi & PnL", "cmd:/positions"], auto: ["🤖 Otomatisasi", "cmd:/auto"],
    history: ["📒 Jurnal", "cmd:/history"], config: ["⚙️ Pengaturan", "cmd:/config"],
  };
  const links: Record<string, string>[] = [];
  if (options.detailCallback && /^(?:position:view:[1-9A-HJ-NP-Za-km-z]{32,44}|auto:position:[a-f0-9-]{36})$/.test(options.detailCallback)) {
    links.push({ text: "📍 Detail posisi", callback_data: options.detailCallback });
  }
  if (options.pool && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(options.pool)) {
    links.push({ text: "↗️ Buka Meteora", url: `https://app.meteora.ag/dlmm/${options.pool}` });
  }
  const action = actions[options.action ?? "positions"];
  return { text: lines.join("\n"), parseMode: "HTML", replyMarkup: { inline_keyboard: [
    ...(links.length ? [links] : []), [{ text: action[0], callback_data: action[1] },
      ...(action[1] !== "cmd:/positions" ? [{ text: actions.positions[0], callback_data: actions.positions[1] }] : [])],
  ] } };
}

function notificationNumber(value: number | null, digits: number, signed: boolean): string {
  if (value === null || !Number.isFinite(value)) return "Belum tersedia";
  const prefix = value < 0 ? "−" : value > 0 && signed ? "+" : "";
  const absolute = Math.abs(value);
  return prefix + (absolute > 0 && absolute < 10 ** -digits ? `<${(10 ** -digits).toFixed(digits)}` : absolute.toFixed(digits)).replace(".", ",");
}

export function notificationSol(value: number | bigint | null, signed = false): string {
  if (value === null) return "Belum tersedia";
  const formatted = notificationNumber(typeof value === "bigint" ? Number(value) / 1e9 : value, 8, signed);
  return formatted === "Belum tersedia" ? formatted : `${formatted} SOL`;
}

export function notificationPercent(value: number | null, signed = false): string {
  const formatted = notificationNumber(value, 2, signed);
  return formatted === "Belum tersedia" ? formatted : `${formatted}%`;
}

export function swapStatusLabel(status: string): string {
  return ({ DRY_RUN_QUOTED: "Quote simulasi berhasil", SKIPPED_DUST: "Dilewati · nilai dust", SKIPPED_NO_TOKEN: "Tidak ada token untuk ditukar",
    SKIPPED_DISABLED: "Swap nonaktif", WAITING_METADATA: "Menunggu metadata transaksi", CONFIRMED: "Terkonfirmasi",
    NO_ROUTE: "Rute swap belum tersedia", FAILED: "Gagal · perlu diperiksa", UNKNOWN: "Status belum diketahui", PENDING: "Menunggu konfirmasi",
  } as Record<string, string>)[status] ?? status.replaceAll("_", " ").toLowerCase();
}



export function positionRangeStatus(activeBin: number | undefined, lowerBin: number, upperBin: number, binStep?: number): string {
  if (activeBin == null || !Number.isFinite(activeBin)) return "Menunggu data bin aktif";
  if (activeBin < lowerBin || activeBin > upperBin) {
    const below = activeBin < lowerBin;
    const delta = activeBin - (below ? lowerBin : upperBin);
    const percent = binStep != null && Number.isFinite(binStep) && binStep > 0
      ? Math.abs(Math.expm1(delta * Math.log1p(binStep / 10_000))) * 100 : NaN;
    const label = !Number.isFinite(percent) ? "persentase belum tersedia"
      : percent < 0.01 ? "<0,01%" : `${percent.toFixed(2).replace(".", ",")}%`;
    return `${below ? "🔻 OOR bawah" : "🔺 OOR atas"} ${label} · jarak ${Math.abs(delta)} bin`;
  }
  return `Dalam range · ${activeBin - lowerBin} bin dari batas bawah · ${upperBin - activeBin} bin dari batas atas`;
}

export function binStepLabel(binStep: number | undefined, baseFeePercent?: number): string {
  if (binStep === undefined) return "Belum tersedia";
  const fee = baseFeePercent === undefined ? "Fee belum tersedia" : `Fee ${Number(baseFeePercent.toFixed(2))}%`;
  return `${binStep} · ${fee}`;
}

export function triggerReasonLabel(reason: string): string {
  return ({
    TAKE_PROFIT: "Target profit neto",
    OOR_ABOVE_PERCENT: "OOR atas persentase",
    OOR_BELOW_PERCENT: "Stop loss OOR bawah",
    INDICATOR: "Sinyal indikator",
    OOR_BELOW: "Harga di bawah range",
    OOR_ABOVE: "Harga di atas range",
  } as Record<string, string>)[reason] ?? reason.replaceAll("_", " ").toLowerCase();
}

export function triggerOutcomeLabel(outcome: string): string {
  return ({
    DRY_RUN: "Simulasi DRY-RUN",
    EXECUTED: "Close dijalankan",
    FAILED: "Gagal diproses",
    OOR_RESET: "Batal · harga kembali ke range",
    IGNORED: "Sinyal exit diabaikan",
    POSITION_CLOSED: "Posisi sudah tertutup",
    ALREADY_FINALIZED: "Trade sudah selesai",
    CLOSE_PENDING: "Menunggu konfirmasi close",
    CIRCUIT_BREAKER: "Dijeda sementara setelah beberapa kegagalan",
  } as Record<string, string>)[outcome] ?? outcome.replaceAll("_", " ").toLowerCase();
}
