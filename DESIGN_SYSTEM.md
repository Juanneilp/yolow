# Yolow Telegram Design System

This document defines the visual style and Telegram message patterns for Yolow. Features and behavior remain governed by `PRD.md`; the image below is a visual reference only.

![Yolow Telegram bot visual reference](<referensi desain yolow.png>)

## Visual principles

- Use the dark Telegram look from the reference: dark background, slightly lighter card surfaces, bright primary text, and blue accents.
- Keep the layout compact: wallet summary at the top, followed by action buttons in a two-column grid.
- Bot-facing messages should be written in Indonesian. Command names must match the PRD, such as `/positions` and `/ignore`.
- Use emoji as quick visual markers. Always include text for important statuses so meaning does not rely on color alone.
- Borrow visual style only. Do not copy the reference bot menus or capabilities.

## Color tokens

Use these values for mockups, illustrations, and UI elements controlled by Yolow. Telegram may use button colors from the user theme, so labels and button order must remain clear in both light and dark themes.

| Token | Value | Use |
|---|---|---|
| `yolow.bg` | `#0F1721` | Dark mockup background |
| `yolow.surface` | `#18232F` | Cards and panels |
| `yolow.button` | `#223140` | Button surface reference |
| `yolow.border` | `#2B3947` | Subtle separators |
| `yolow.text` | `#F4F7FA` | Primary text |
| `yolow.muted` | `#96A6B7` | Metadata and timestamps |
| `yolow.accent` | `#56A8F5` | Links and primary actions |
| `yolow.success` | `#53B987` | Successful close or swap |
| `yolow.warning` | `#E8B34D` | Dry-run, dust, or stale data |
| `yolow.danger` | `#E36B6B` | Critical errors or failed transactions |

Always show status text, for example `✅ CLOSED`, `🟡 DRY-RUN`, `⚠️ STALE DATA`, or `🔴 CLOSE FAILED`. Localize these labels into Indonesian in the actual bot.

## Screen and message patterns

### Home and status

The welcome message uses the title `Yolow · Meteora DLMM`, followed by a short wallet summary:

```text
⚡ Yolow · Meteora DLMM
Wallet    7xAb…p9Q2
Balance   3.42 SOL
Mode      DRY-RUN
Positions 4 active · 1 ignored
```

Show only an abbreviated public key. Never display a secret or keypair path. `/start` shows this summary with persistent quick-access buttons. Tapping `🏠 Menu` opens the summary with the inline feature menu.

The inline menu uses Yolow features:

| Row | Buttons |
|---|---|
| 1 | Status · Posisi & PnL |
| 2 | Top Careless · Jurnal |
| 3 | Pengaturan · Bantuan |

The persistent keyboard uses `🏠 Menu` and `📍 Posisi & PnL` on the first row, with a full-width `🧪 Top Careless` button on the second row. The shortcuts open `/positions` and `/topcareless`; `/start` replaces an older keyboard. Keyboard navigation cancels pending configuration input. Position detail contains Ignore/Unignore controls. Jurnal opens `/history` with Refresh, Statistics, and Export CSV buttons, including for empty history. Show usage and examples for `/trade`, `/note`, `/tag`, and `/retryswap` rather than argument-free buttons.

Pengaturan opens `/config` with Automation and Live Mode, plus execution, historical data, records, Careless and system sections. `/auto` shows dry-run slots, balances, blocked mints and pending swaps. Old timeframe/indicator/bin-count OOR controls show removal notices. Reject LIVE while automation is active. Configuration parameters remain editable as supported by the command handler.

Register only `/start`, `/menu`, `/status`, `/positions`, `/topcareless`, `/history`, `/config`, and `/help` in the native Telegram command menu. Help groups all supported commands into Pemantauan, Screening, Jurnal, and Pengaturan, including advanced command usage and the `/pnl` alias. Submenus provide Menu navigation.

Top Trending has been removed. Old commands, keyboard labels, and discovery/filter buttons show a removal notice and the main menu without fetching market data. Old parameter-editor buttons reject changes to removed parameters.

### Top Careless Strat

Use **🧪 Top Careless** in the inline feature menu and `/topcareless` in native commands and help. Keep Top Careless alongside Menu and Posisi & PnL in the persistent keyboard. Use a separate filter section with defaults: enabled, 10 results, market cap ≥ $1.5M, token age ≥ 3 days, pool TVL ≥ $5K, and an empty manual blacklist. All six `top_careless` parameters are editable without restart.

Include `/blacklist` in Screening help as an advanced command, keeping the eight native commands. `/blacklist` lists full CAs, `/blacklist add <CA>` adds one, and `/blacklist remove <CA>` removes one. Validate exact Solana addresses locally; preserve case. Store in `top_careless.blacklisted_mints` with immediate application. Exclude all matching pools before limiting results and reject new automatic entry/reentry. Existing positions retain monitoring and exits. Keep manual blacklist and loss blocks independent. The screening filter header shows the manual blacklist count and `/blacklist`. Example confirmation: `✅ CA <CA> ditambahkan ke blacklist.`, followed by immediate-effect and Refresh guidance. Existing messages require Refresh to reflect changes.

Show every qualifying token/SOL pool separately, ranked by Simple Fee/TVL 24h descending, then 24-hour volume descending, then pool address. Estimated base fees = Volume 24h × (base_fee_pct / 100); Simple Fee/TVL (%) = estimated base fees / TVL × 100. Read base_fee_pct from pool_config. Keep APR = Fee/TVL 24h percentage × 365 as a comparison; do not multiply percentages by 100 again or include farm rewards. Missing or invalid comparison data does not exclude a pool. Age comes from Jupiter's first pool timestamp. Do not apply holder, Organic Score, or maximum-age filters.

Cards show token/SOL, token name, market cap, age, TVL, volume 24h, base fee, Simple Fee/TVL 24h, estimated APR, Fee/TVL 24h, bin step, full copyable CA and pool address, and a **Buka Meteora DLMM** HTML link to `https://app.meteora.ag/dlmm/<pool>`. Example: `Base fee 0.30% · Simple Fee/TVL 24j 3.00%` for volume $100K and TVL $10K. Sanitize labels and escape HTML. Provide Refresh, Filter and Menu navigation. Show unavailable bin step, APR, or Fee/TVL explicitly; exclude records with missing required ranking/filter data or nonpositive TVL. Zero volume and zero base fee are valid. Scan until the final page or the cap of 20 × 100 pools, even when enough results have been found; keep source ordering by Fee/TVL 24h then volume 24h and compute the final ranking locally. If more pages remain beyond the cap, explain that ranking covers only scanned pools even when results are full. Explain empty results when applicable and that the simple estimate excludes dynamic fees and protocol deductions and does not guarantee position returns. Use the existing sender's message splitting for long output.

Use a separate title, result count, active filter block, and update time with timezone. Each pool card starts with its rank and pair in bold, then its name in italics. Use medals for the first three ranks and a neutral marker after that; ranking only reflects the stated metric. Put the bold Simple Fee/TVL score first, followed by TVL/volume, market cap/age, base fee/bin step, and comparison APR/Fee/TVL. Separate addresses and the Meteora link from the metrics with whitespace. Keep the explanation under **Cara baca** at the end. Every HTML tag must close on the same line so message splitting preserves valid formatting.

After the name and before metrics, show two independent bold wallet markers: `👛 Token: SUDAH ADA · 3 posisi di 2 pool` and `🏊 Pool ini: AKTIF · 2 posisi`. Match exact mint addresses on either side of each real open position and exact pool addresses; never compare symbols. Deduplicate position IDs and count distinct pools for each mint. A token held in another pool has SUDAH ADA at token level and BELUM ADA for this pool. Owned results remain in their original ranking.

Count actual OPEN positions, including ignored positions and real positions with a completed paper-close simulation. Exclude virtual positions and actual CLOSED positions. Header shows the last successful wallet-discovery time in the configured timezone; do not infer freshness from price-feed updates. The marker uses the existing snapshot with no extra RPC. Failed discovery, unknown/invalid/future timestamps, or age beyond two configured polling intervals makes the snapshot stale: positive counts say `data terakhir`; unmatched values say `BELUM TERVERIFIKASI`. A valid empty snapshot may show BELUM ADA. Explain the snapshot semantics in Cara baca and retain line-balanced HTML/message splitting.

Example card (Telegram renders the emphasis):

```text
🥇 1. TOKEN/SOL
Token Name

👛 Token: SUDAH ADA · 3 posisi di 2 pool
🏊 Pool ini: AKTIF · 2 posisi

💎 Simple Fee/TVL 24j 3.00%
💧 TVL $10.0K · 📊 Volume 24j $100.0K
💵 MCap $1.5M · 🕓 Umur 7.0 hari
⚙️ Base fee 0.30% · Bin step 25
📈 APR estimasi 36.50% · Fee/TVL 24j 0.10%

CA <full mint address>
Pool <full pool address>
↗️ Buka Meteora DLMM
```

### Positions and PnL

Use one **📍 Posisi & PnL** entry in the inline and native command menus. `/positions` is the main command; `/pnl` and older PnL buttons open the same view for compatibility.

Show five open positions per page, sorted by highest PnL in SOL. Equal values follow discovery order; unavailable PnL comes last. Each compact card shows its number, token pair, shortened position ID, signed PnL in SOL and percent, range status, exit status, and fetch time. Use bold PnL and text plus emoji to distinguish profit, loss, zero, and unavailable data. Very small nonzero values use a signed threshold (for example, `−<0.00000001 SOL`) instead of negative zero.

The header totals available PnL and states coverage, such as `PnL terhitung 3/4`. Include ignored positions in PnL. Label cached results when a refresh fails or when the last fetch is older than two minutes. Never display unavailable PnL as zero.

For positions outside their range, show `🔺 OOR atas 2,53% · jarak 10 bin` or `🔻 OOR bawah 2,47% · jarak 10 bin` in both list and detail. Measure price distance relative to the crossed boundary using compounded bin steps, not the move needed to return. Use two decimal places and `<0,01%` for smaller distances. If bin step is missing or invalid, show `persentase belum tersedia` and keep the direction and bin distance. Detail explains that the percentage uses the last stored active bin; direction follows DLMM bin order.

Example list (Telegram renders the title and PnL in bold):

```text
📍 POSISI & PnL · 2 posisi
PnL terhitung 2/2 · +0.01192000 SOL
Exit aktif 1 · Diabaikan 1
Halaman 1/1 · PnL SOL terbesar

1. BONK/SOL · AiEkQ…tuyn1
🟢 PnL +0.01234000 SOL (+2.4680%)
🧭 Dalam range · ✅ Exit aktif
🕒 Diambil: 19 Okt 2026, 14.05.00 WIB

2. TOKEN/SOL · 9hEzf…XbeFd
🔴 PnL −0.00042000 SOL (−0.0840%)
🧭 🔻 OOR bawah 2,47% · jarak 10 bin · ⏸ Exit diabaikan
🕒 Diambil: 19 Okt 2026, 14.05.00 WIB
```

Numbered **Detail** buttons identify each position, including positions with the same pair. Put page navigation and **Refresh** below them. Keep every message under the internal 3,500-character limit so refresh can edit the same bubble.

Detail puts PnL and exit state first, followed by deposits, withdrawals, claimed fees/rewards, token name, bin step and fee, range, active bin, range distances, last exit signal, discovery time, and full copyable position/pool addresses. Show fetch and provider balance-update timestamps separately. Include **Refresh**, **Abaikan exit** or **Aktifkan exit**, and **Kembali ke daftar**. Updating exit state keeps the detail open; returning opens page one.

Explain that PnL is a Meteora lifetime estimate including fees/rewards, with gas and liquidation slippage excluded. Escape all dynamic HTML, including names and provider errors.

### Profit reminders

Expose `notify.profit_alert.enabled`, `interval_minutes`, and `threshold_percent` in **Notifikasi & riwayat**. Defaults are enabled, five minutes, and strictly above 5%; changes apply without restart. Send one combined HTML card summary per interval when eligible open positions exist, including positions with ignored exits. Order by highest profit percentage and show token pair, shortened position ID, signed SOL PnL, and percentage. Use existing token labels with a shortened mint fallback.

Title the message **💰 POSISI PROFIT DI ATAS AMBANG**. Include qualifying count, configured threshold and interval, check time, the Meteora estimate caveat, and `/positions` for detail. Keep messages under 3,500 characters; split long summaries into numbered parts without dropping positions. Do not send reminders from manual refresh, failed fetches, missing values, or fetch results older than two minutes.

### Event notifications

Use the shared HTML card formatter for all background notifications: discovery, entry/close/swap, profit, balances, recovery, backup/export errors and daily summaries. Order: bold event title, bold token label when known, explicit DRY-RUN/SIMULASI or LIVE, a light separator, labeled facts, explanatory action, full copyable addresses, configured local time, then buttons.

Use Indonesian labels, SOL with eight decimal places and percent with two, decimal commas, and explicit positive/negative signs for PnL. Tiny nonzero values use a signed threshold instead of zero. Unknown amounts say `Belum tersedia`. Token labels use existing cached metadata with a shortened mint fallback; formatting must not add RPC calls or block trading on metadata lookup. Escape/redact dynamic text; address fields use `<code>`. Every HTML tag closes on its own line. Disable link previews.

New positions show real-wallet origin, monitoring state, bin step, base fee and range. Missing positions say `Pemantauan dihentikan` and do not claim they were closed or sold. New/active position cards link to the existing detail callback and Meteora. Completed closes link to the journal; system problems link to settings. Include a Positions & PnL shortcut beside other section shortcuts. Only the first part of a multipart notification carries buttons.

Paper close sends separate `CLOSE SIMULASI DIMULAI` and `CLOSE SIMULASI SELESAI` cards. Emit start only after OPEN → CLOSING commits. The final card shows estimated net position PnL, readable reason/swap labels, and manual/virtual origin. Manual positions remain open on-chain and continue occupying real slots. Loss cards explain the mint block and distinguish old-wallet-token proceeds from LP profit. Dust is unswapped token with no swap gas or realized SOL.

On a failed pending paper swap, send one `SWAP SIMULASI TERTUNDA` card and record its notification marker in existing automation events. Retries/restarts do not repeat start/waiting notices; send a final result when completed. Do not change financial records due to notification failure. Delivery remains best-effort: no outbox, replay of old start messages, or guarantee during a network outage.

Example final card (Telegram renders emphasis):

```text
🟡 CLOSE SIMULASI SELESAI
TOKEN/SOL
🟡 DRY-RUN · SIMULASI

━━━━━━━━━━━━━━━━━━

Profit neto estimasi  +0,02500000 SOL (+5,00%)
Alasan  Target profit neto
Asal  Posisi manual
Swap  Quote simulasi berhasil
SOL swap posisi estimasi  0,10000000 SOL
Posisi nyata tetap terbuka dan memakai slot.

Posisi
<full position address>
Pool
<full pool address>
CA
<full mint address>

🕒 25 Okt 2026, 16.40.00 WIB

[Buka Meteora]
[Jurnal] [Posisi & PnL]
```

## Consistency rules

- Preserve journal/CSV storage codes and translate them into clear Indonesian labels in notifications.
- Use the configured timezone and its actual timezone label; WIB applies to Asia/Jakarta.
- Use SOL for SOL balances and values; include units for every number.
- Keep buttons short and action-oriented. Put details in the position view or command result.
- The `/golive` confirmation shows the current mode, abbreviated wallet, number of positions to be managed, and swap status before the confirmation button.
- Exclude reference-image features that are not in the Yolow PRD, including LP creation, DCA, referrals, and other chains.

## Automation presentation

Always label automation entries, closes and swaps as SIMULASI/DRY-RUN. Show real and virtual counts separately; a simulated manual close still consumes a real slot. Virtual cards use 🟡 VIRTUAL and estimated net SOL PnL. Mark closed manual simulations explicitly while the real position remains OPEN. `/auto unblock <mint>` removes a loss block only after its pending swap is resolved. Pending swaps and dust must never be displayed as realized SOL.

Example: `Slot 16/15 · nyata 16 · virtual 0` followed by `Entry menunggu slot`. Notifications state the exit percentage reason, source/paper ID, pool, net estimated SOL profit, and swap result.
