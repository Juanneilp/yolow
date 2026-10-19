export function notificationCard(title: string, details: string[]): string {
  return [title, "━━━━━━━━━━━━━━━━━━", ...details].join("\n");
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
