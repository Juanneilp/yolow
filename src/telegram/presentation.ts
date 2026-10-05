export function notificationCard(title: string, details: string[]): string {
  return [title, "━━━━━━━━━━━━━━━━━━", ...details].join("\n");
}

export function positionRangeStatus(activeBin: number | undefined, lowerBin: number, upperBin: number): string {
  if (activeBin === undefined) return "Menunggu data bin aktif";
  if (activeBin < lowerBin) return `Di bawah range · jarak ${lowerBin - activeBin} bin`;
  if (activeBin > upperBin) return `Di atas range · jarak ${activeBin - upperBin} bin`;
  return `Dalam range · ${activeBin - lowerBin} bin dari batas bawah · ${upperBin - activeBin} bin dari batas atas`;
}

export function binStepLabel(binStep: number | undefined, baseFeePercent?: number): string {
  if (binStep === undefined) return "Belum tersedia";
  const fee = baseFeePercent === undefined ? "Fee belum tersedia" : `Fee ${Number(baseFeePercent.toFixed(2))}%`;
  return `${binStep} · ${fee}`;
}

export function triggerReasonLabel(reason: string): string {
  return ({
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
