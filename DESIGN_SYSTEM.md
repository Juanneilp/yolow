# Yolow Telegram Design System

This document defines the visual style and Telegram message patterns for Yolow. Features and behavior remain governed by `PRD.md`; the image below is a visual reference only.

![Yolow Telegram bot visual reference](<referensi desain yolow.png>)

## Visual principles

- Use the dark Telegram look from the reference: dark background, slightly lighter card surfaces, bright primary text, and blue accents.
- Keep the layout compact: wallet summary at the top, followed by action buttons in a two-column grid. A full-width `Top Trending` row is acceptable if needed.
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
| 1 | Status · Positions |
| 2 | History · Statistics |
| 3 | Timeframe · Export |
| 4 | Top Trending · Configuration |
| 5 | Advanced commands |

The persistent keyboard uses `🏠 Menu` and `🔥 Top Trending`. The Timeframe button opens the same choices as `/tf <5m|15m|30m|1h>`. Display the active timeframe; a timeframe selected in Telegram persists after restart. RSI, BB, and MACD parameters are not editable through the menu. Advanced commands list the argument-based journal and position commands.

### Top Trending results

The persistent Telegram keyboard has **🏠 Menu** and **🔥 Top Trending** buttons. **Menu** and `/menu` show the wallet summary and inline feature grid; **Top Trending** and `/toptrending` show 10 qualifying tokens by default. Use Telegram HTML bold/monospace for hierarchy, a compact filter summary, and a divider between token cards. Each card shows symbol/name, MarketCap, age, holders, SOL-quoted DLMM pair, TVL, Jupiter Organic Score, and 24-hour volume. Show the full mint and pool address as separate `<code>` entities so users can tap to copy the complete values. Only SOL-quoted pools are listed; do not show `/USDC` pairs. Keep actual bot copy in Indonesian. This is a read-only discovery view; do not show buy, swap, or open-position actions.

Example result block:

```text
🔥 TOP TRENDING · 10/10
🔎 MCap ≥ $500K · Age 6h–60d · Holders ≥ 1K · TVL ≥ $10K · Organic ≥ 70
📊 Meteora DLMM · SOL pairs only · Ranked by 24h volume
🕒 Updated 03 Oct 2026, 14:05 WIB
━━━━━━━━━━━━━━━━━━━━
1. TOKEN · Token Name
💵 MCap $620K · 🕓 8.4h · 👥 1,240
🔗 TOKEN/SOL · 💧 TVL $18.2K · 🌱 Organic 82 · 📈 24h $95K
CA 6GmAFS123456789ABCDEFGHJKLMNPQRSTUVWXYZUNgx · Pool zxTpi4123456789ABCDEFGHJKLMNPQRSTUVWXYZSCLX
```

### Position list and details

Each position shows its symbol/pair, abbreviated public key, bin range, active bin, lower/upper OOR distance, trigger status, and `ACTIVE` or `IGNORED` status. Show one position per block so its actions cannot be confused with another.

On a position detail, show a contextual button based on the stored state: `Ignore position` or `Unignore position`. These buttons invoke the same actions as `/ignore <position>` and `/unignore <position>`.

### Event notifications

Use a consistent order: event icon and type, position/pair, reason, key value, WIB timestamp, then signature/link if available. Example:

```text
🔴 CLOSE FAILED · BONK/SOL
Reason: Lower OOR · 21 bins
Position: 7xAb…p9Q2
Time: 03 Oct 2026 14:05 WIB
Action: Position remains monitored
```

Successful close, dust, stale-data, and circuit-breaker messages use the same structure with an appropriate status. An error should state the next action when a relevant command exists.

## Consistency rules

- Use the same terminology and statuses in Telegram, the journal, and CSV.
- Display all times using the WIB format defined in the PRD.
- Use SOL for SOL balances and values; include units for every number.
- Keep buttons short and action-oriented. Put details in the position view or command result.
- The `/golive` confirmation shows the current mode, abbreviated wallet, number of positions to be managed, and swap status before the confirmation button.
- Exclude reference-image features that are not in the Yolow PRD, including LP creation, DCA, referrals, and other chains. Top Trending is included as a separate, read-only Yolow feature in the PRD.
