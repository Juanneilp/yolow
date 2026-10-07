# Yolow Agent

Yolow monitors every Meteora DLMM position owned by one Solana wallet. It tracks active bins and finalized candles, sends alerts to one whitelisted Telegram chat, and can simulate or submit a full position close followed by a token-to-SOL Jupiter swap. The default mode is `dry_run: true`.

## Setup

Requirements: Node.js 22.21 or newer, a Telegram bot, a Helius API key, a Jupiter API key, and the public key of the monitored wallet.

```sh
cp config.example.json config.json
cp .env.example .env
chmod 600 .env config.json
npm install
```

Set these values in `.env`:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
# Optional when using a group chat; only this Telegram user can control Yolow.
TELEGRAM_USER_ID=...
HELIUS_API_KEY=...
AGENT_WALLET_PUBKEY=...
JUPITER_API_KEY=...
```

`GMGN_API_KEY` is optional for Top Trending ATH data. In a private chat, leave `TELEGRAM_USER_ID` blank; it defaults to `TELEGRAM_CHAT_ID`. In a group, set the allowed sender's numeric Telegram user ID. Live signing also requires `AGENT_KEYPAIR_PATH`; point it to a Solana JSON keypair stored outside this repository with file permissions set to `600`. The agent checks that the keypair matches `AGENT_WALLET_PUBKEY`. Never put the secret key in `.env`, `config.json`, or Telegram.

Yolow restricts secret-bearing RPC and Jupiter requests to their configured HTTPS hosts and rejects redirects; endpoint credentials belong in `.env`, never in config URLs. Startup tightens `.env` and config file permissions to `600`. Telegram control requires both the configured chat and sender ID. Live Jupiter builds are checked for the expected token pair, amount, router program, instruction signers, and wallet-owned token accounts before signing.

`DB_PATH` and `CONFIG_PATH` are optional. They default to `./data/yolow.db` and `./config.json`.

## Run

```sh
npm start
```

Run under PM2:

```sh
pm2 start ecosystem.config.cjs
pm2 logs yolow
pm2 restart yolow
pm2 stop yolow
```

In Telegram, send `/start` and tap **Menu**. `/status` and `/positions` show the current agent state. `/ignore <position_id>` and `/unignore <position_id>` persist exclusions; `/tf <5m|15m|30m|1h>` selects the indicator timeframe. The menu also provides journal, export, and Top Trending commands.

Open **⚙️ Konfigurasi** or send `/config` to browse settings. Tap a section, then tap a parameter to edit it: booleans and preset lists (timeframe, volume window, candle provider, price unit) use buttons, while numbers, arrays, and free-form strings use **✏️ Ketik nilai** and accept the raw value as your next message (send `batal` to cancel). The equivalent `/config set <path> <value>` syntax still works, for example `/config set oor_exit.below.trigger_bins 24` or `/config set indicator_exit.enabled false`. Config changes are atomically saved and audited. Values that need process reinitialization say so in the reply; API secrets and `mode.dry_run` cannot be changed through Telegram.

While `dry_run` is enabled, Yolow simulates Meteora close transactions and requests Jupiter Swap V2 build quotes without signing or sending. To enable live transactions, configure the external keypair and use `/golive`, then press its confirmation button. Every live close and swap is simulated before broadcast; uncertain broadcast status is recorded and never retried automatically.

## Current provider coverage

Meteora DLMM and GeckoTerminal candle retrieval are implemented. GMGN candle data and `onchain_ticks` are not integrated, so those configured entries are skipped and the fallback chain continues. If no supported provider returns finalized candles, indicator exits pause and OOR monitoring continues. Meteora candle price units still need to be compared with the chosen chart source before relying on live indicator exits; keep the default dry-run mode during that review.

GeckoTerminal requests are serialized to stay near its public API rate limit. The free endpoint is cached and rate limited, so it is intended as a fallback. Set per-pool `indicator_exit.timeframe` or `oor_exit` overrides in `pool_overrides` when a pool needs different settings; `/tf` changes the default timeframe for pools without an override.

Top Trending remains read-only. Its filters (MCap, token age, holders, TVL, Organic Score, and result limit) and the ranking volume window (`top_trending.volume_window`: `4h`, `12h`, or `24h`; the Meteora API has no 6-hour window) are editable from the **🔥 Top Trending** config section. Result cards have **🔄 Refresh** and **⚙️ Filter** buttons. GMGN ATH MarketCap is shown as `N/A` when the API key or matching token data is unavailable.
