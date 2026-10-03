# Yolow Agent — Phase 1

Phase 1 implements the read-only Telegram **Top Trending** feature. Candidate pools come only from Meteora DLMM. Jupiter Tokens API V2 enriches candidate mints with first-pool time and Organic Score. GMGN AI supplies ATH MarketCap data. The bot does not buy tokens, open LP positions, or submit transactions.

## Requirements

- Node.js 22.21 or later
- A Telegram bot token and the allowed Telegram chat ID
- A Jupiter API key
- A GMGN AI API key to show ATH MarketCap and drawdown (optional until configured)

## Setup

Open PowerShell in the project folder (`D:\Development\yolow`). Run these copy commands once. They leave existing local files unchanged:

```powershell
if (-not (Test-Path .\config.json)) { Copy-Item .\config.example.json .\config.json }
if (-not (Test-Path .\.env)) { Copy-Item .\.env.example .\.env }
```

Edit `.env` and fill in:

```text
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_allowed_chat_id
JUPITER_API_KEY=your_jupiter_api_key
GMGN_API_KEY=your_gmgn_api_key
```

Keep `.env` private; it is excluded from Git. Do not send these secrets in Telegram or commit them. Phase 1 does not need a Solana wallet or private key.

`config.json` is a local copy of `config.example.json`. The Top Trending defaults are already present. To change the result count or thresholds, edit the `top_trending` block in `config.json`; restart the bot for changes to take effect. Keep `config.example.json` as the clean template.

Run the tests, then start the bot:

```powershell
npm.cmd test
npm.cmd start
```

No dependency installation is required for this phase. To stop the bot, press `Ctrl+C` in the PowerShell window.

In the allowed Telegram chat, send `/start` to show the persistent **Menu** and **Top Trending** buttons. Tap **Menu** or send `/menu` to see available commands; tap **Top Trending** or send `/toptrending` to view the results.

The initial settings are 10 results, MarketCap ≥ $500,000, first pool age from 6 hours through 60 days, holders ≥ 1,000, DLMM pool TVL ≥ $10,000, and Jupiter Organic Score ≥ 70. Only SOL-quoted DLMM pools are considered; USDC-quoted pools are excluded. Results are ranked by 24-hour DLMM pool volume. With `GMGN_API_KEY` configured, each token also shows its GMGN ATH MarketCap and the percentage below that ATH; if GMGN has no matching ATH data, it shows `N/A`. The GMGN key is sent only in the request header and is not needed to start the bot.

The ATH lookup uses GMGN's first 100 Solana tokens ranked by 24-hour volume; matching is by mint address. Tokens outside GMGN's returned rank list show `N/A` rather than using an OHLCV-derived estimate.
