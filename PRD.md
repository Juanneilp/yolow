# PRD — Yolow Agent: Auto-Exit and Auto-Swap for Meteora DLMM Positions

Version 0.9 (discussion draft) · 2026-10-03 (WIB) · Status: core strategy decisions confirmed; implementation details remain open

> References such as “Section 5.2” refer to this document. The complete example configuration is in `config.example.json` (Section 10).
>
> **Time zone:** all times shown to users use WIB (GMT+7, Asia/Jakarta); see Section 10.4.

---

## 0. Changes since v0.6

| # | Change | Reason |
|---|---|---|
| 1 | Position ignore flags can be changed through Telegram and are persisted in SQLite; they apply to indicator and OOR triggers | User requirement |
| 2 | Monitor every wallet position; remove the position allowlist and use `/ignore` for exclusions | User requirement |
| 3 | Remove global `/pause` and `/resume` commands; automatic protection for stale data and repeated close failures remains | User requirement |
| 4 | `swap.enabled` is a global switch: true = close then swap subject to the dust threshold; false = close only | User requirement |
| 5 | Dry-run needs only the wallet public key. Live mode needs a keypair file outside the repository; `.env` stores only its path | Reduce secret exposure |
| 6 | Align architecture diagram and decision log with the Meteora fallback | Document consistency |
| 7 | Use `referensi desain yolow.png` as a Telegram visual reference only; Yolow retains its own feature set | User reference |
| 8 | Indicator signals still close positions with 100% SOL exposure; RSI/BB/MACD use active defaults and are not editable through Telegram | User decision |
| 9 | Close below or above the range after the distance from the corresponding range boundary reaches 20 bins, including when already beyond the threshold at startup | User decision |
| 10 | Telegram provides `/ignore`, `/unignore`, and `/tf`; the selected timeframe persists | User decision |
| 11 | Do not block swaps based on price impact; record impact for audit | User decision |
| 12 | Confirm OOR conditions continuously for 5 seconds below and 30 seconds above; reset the timer below the 20-bin threshold | User decision |
| 13 | Add a read-only `Top Trending` Telegram menu/command for 10 qualifying Meteora DLMM tokens by default, with configurable filters | User decision |
| 14 | Limit Top Trending results to DLMM pools quoted in SOL; exclude meme/USDC pairs | User decision |
| 15 | Only show Top Trending tokens aged from 6 hours through 60 days | User decision |
| 16 | Add persistent Telegram buttons for `Menu` (show available commands) and `Top Trending` | User decision |
| 17 | Show Top Trending tokens' GMGN ATH MarketCap and percentage below ATH using GMGN's provided field, not candle-derived ATH | User decision |

### History: v0.5 → v0.6

| # | Change | Reason |
|---|---|---|
| 1 | Add the Meteora DLMM Data API as a candle provider (`meteora`): `GET dlmm.datapi.meteora.ag/pools/{pool}/ohlcv`, no API key, 30 requests/second | Official, pool-specific source that does not depend on GMGN access |
| 2 | Set fallback order to `gmgn → meteora → geckoterminal → onchain_ticks` | Meteora is closer to the position pool than GeckoTerminal |
| 3 | Meteora has no 15m timeframe (available: 5m/30m/1h/2h/4h/12h/24h); build 15m candles from three 5m candles | Documentation review |
| 4 | Shadow mode compares GMGN, Meteora, and on-chain data | Basis for selecting the primary source |
| 5 | Replace the old REST host `dlmm-api.meteora.ag` with `dlmm.datapi.meteora.ag` | Host replacement |
| 6 | Add an open decision to select the primary candle source after dry-run | Next decision |

### History: v0.4 → v0.5

| # | Change | Reason |
|---|---|---|
| 1 | Display all user-facing times in WIB: Telegram, CSV, SQL views, logs, statistics, and backup filenames | User decision |
| 2 | Add `timezone` to `config.json`, defaulting to `Asia/Jakarta`, independent of server OS time zone | VPS servers commonly use UTC |
| 3 | Keep internal timestamps as UTC epoch and convert for display; SQL views expose `_wib` columns | Match on-chain/provider timestamps and avoid ambiguity |
| 4 | Schedule daily jobs in WIB: backups at 03:00, heartbeat at 08:00, and statistics day boundary at 00:00 WIB | Consistent reporting |
| 5 | Candle boundaries for 5m–1h match in UTC and WIB; indicators are unaffected | Clarify time-zone behavior |

### History: v0.3 → v0.4

| # | Change | Reason |
|---|---|---|
| 1 | Add a complete per-position trade journal in one SQLite database, viewable through Telegram, CSV, or a SQLite viewer | User wants to study trading history |
| 2 | Track prices 15m/1h/4h/24h after exit to assess exit timing | Primary learning data |
| 3 | Record virtual trades during dry-run | Evaluate rules before live use |
| 4 | Add MFE/MAE, time-in-range, per-trade config snapshots, candle context, and indicator values | Trace results to the parameters that produced them |
| 5 | Add daily backups, retention, and a `history` config block | Preserve learning data |

### History: v0.2 → v0.3

| # | Change | Reason |
|---|---|---|
| 1 | Add force-close OOR triggers at 20 bins below or above the range, with separate parameters | User decision; addresses memecoin downside risk |
| 2 | Use USD as the price-series unit, equivalent to a USD market-cap chart when supply is constant | User reads the MarketCap chart; indicators are invariant to constant scaling |
| 3 | Keep all non-secret parameters in one `config.json` file instead of YAML; secrets remain in `.env` | User decision |
| 4 | OOR arming was initially added to avoid closing positions placed far from market; removed in v0.8 per user decision to close whenever the 20-bin threshold is reached | Updated user decision |
| 5 | Validate config schema; do not allow `dry_run: true → false` via file edit without restart or `/golive` | Prevent accidental live execution |
| 6 | Clarify that lower OOR is a last-resort safety net, not a tight stop-loss | Risk transparency |

---

## 1. Summary

Yolow is a 24/7 agent that monitors every Meteora DLMM liquidity position owned by one Solana wallet. The target pools are memecoin/SOL with single-sided SOL deposits. Yolow fully closes a position when either:

- A technical exit signal fires (RSI(2), Bollinger Bands, and MACD), or
- The active price moves at least 20 bins below or above the corresponding position range boundary.

After closing, Yolow swaps the memecoin tokens received to SOL through Jupiter when their estimated value is at least $0.50. Telegram provides alerts, commands, and an audit trail. Each position produces a complete trade record for later analysis (F9).

## 2. Background and problem

- Manually managed DLMM positions require attention 24/7. A 15-minute candle closes 96 times a day, including overnight; manual execution will miss some events.
- The exit strategy seeks an overbought confluence (extreme RSI(2) plus BB or MACD confirmation), often during a fast pump that is difficult to catch manually.
- Memecoins can continuously fall or rug. Without an exit boundary, a single-sided SOL position keeps buying the token on the way down.
- Memecoin tokens remaining in the wallet after a close are still exposed to risk, so they should be swapped to SOL promptly.

## 3. Strategy profile and position assumptions

**Confirmed user profile:** token-memecoin/SOL pools, **single-sided SOL** deposits, Spot or Curve liquidity shape, and a **MarketCap (USD)** chart.

**Relevant position behavior** (SOL is the quote asset, the token is the base asset, and a higher bin ID means a higher token price):

- As price falls through the position bins, the LP buys the token with SOL.
- As price rises through the position bins, the LP sells the token back into SOL.
- Below the position range (active bin below the lower position bin), the position is 100% token.
- Above the position range (active bin above the upper position bin), the position is 100% SOL and earns no fees.

**Design implications:**

1. A position may contain both SOL and token when a trigger fires; swap token to SOL after the close (F5).
2. An overbought rule cannot protect a downtrend that never becomes overbought; the lower OOR trigger provides that protection (Section 5.7).
3. Indicator series use token prices in USD (Section 5.1).
4. Derive the token CA/mint automatically from each position pool.

## 4. V1 goals and non-goals

**V1 goals:**

1. Detect exit signals on candle close at 5m/15m/30m/1h; default 15m, dynamically changeable.
2. Trigger upper and lower OOR exits from the live active bin, with separate parameters (Section 5.7).
3. Fully automate closing 100% of a position (remove liquidity, claim swap fees and farming rewards, and close the position account) without manual confirmation.
4. Auto-swap close proceeds to SOL when their value is at least $0.50; report and leave dust below that threshold.
5. Monitor every wallet position; allow per-position ignore flags that can be managed in Telegram and persist across restarts.
6. Provide Telegram notifications and basic commands; keep all non-secret parameters in one `config.json`.
7. Keep a complete history per position (entry, holding period, exit, swap, outcome, and post-exit behavior) in one place, easy to view and export (F9).
8. Provide a read-only `Top Trending` Telegram feature showing 10 qualifying tokens by default, using configurable filters and Meteora DLMM pools (F10).

**Out of scope for V1:**

- Opening new positions, re-entry, or rebalancing.
- Swapping anything other than tokens received from the close; never sell unrelated wallet token balances.
- Value-based triggers (loss limit %, time-based exits); candidates for v1.1.
- Multiple wallets, web dashboard (v2), tax/portfolio accounting, or backtesting.
- Buying tokens or opening positions from `Top Trending`; it is discovery and display only.

## 5. Exit trigger specification

There are two independent trigger types. Whichever fires first starts a close, with one in-flight close per position (Section 11). Record the reason as `trigger_reason`.

### 5.1 Price and candle sources (indicator triggers)

- **Primary candle source: GMGN AI** (user decision; user will provide API access): OHLCV on the Solana chain per token CA. Automatic fallback order: `gmgn → meteora → geckoterminal → onchain_ticks`. Confirm the final primary source after dry-run and shadow-mode comparison (Open Question 10).
- **Series unit: USD (recommended).** The user reads MarketCap. If supply is constant, MarketCap = price × supply, so a MarketCap series is price scaled by a constant. RSI, the Bollinger close-above-upper comparison, and the MACD histogram sign do not change under constant scaling. Therefore, USD token price produces the same indicator signals as a USD MarketCap chart; the agent does not need to fetch MarketCap. RSI threshold 90 remains unchanged.
  - Exception: if supply changes through burns or mints, MarketCap can jump while price does not, which can change the chart signal for that candle. This is rare and should be checked during dry-run.
  - For `onchain_ticks`, the pool price is initially in SOL. Convert to USD using SOL/USD (`candles.providers.onchain_ticks.sol_usd_source`) so the series stays consistent. If conversion fails, treat it as a series change and backfill again (Section 5.3).
  - If the GMGN chart has a USD/SOL toggle and the user normally reads SOL, set `candles.price_unit` to `sol`.
- **Verification note (2026-10):** public GMGN docs expose a Cooperation API gated by trading volume and IP allowlisting, at roughly 2 requests/second; a public REST OHLCV endpoint is not documented. Confirm whether returned values represent price or market cap and whether the unit is USD or SOL using the access documentation provided by the user (Open Question 1).
- **Meteora DLMM Data API** (`meteora`): official, pool-specific, no API key, 30 requests/second. Endpoint: `GET https://dlmm.datapi.meteora.ag/pools/{pool}/ohlcv?timeframe=...&start_time=...&end_time=...` (Unix seconds). Response fields: `timestamp`, `timestamp_str` (UTC), `open`, `high`, `low`, `close`, and `volume`. Available timeframes: 5m, 30m, 1h, 2h, 4h, 12h, 24h (no 15m); construct a 15m series from three 5m candles (Section 6 F2). In a direct test on a SOL/USDC pool at 1h, each candle opened at the prior candle close, producing a continuous series. Still to verify in an initial spike: price units for memecoin/SOL pools (likely SOL per token, then convert to USD as for `onchain_ticks`), whether the current candle is returned, handling of intervals without trades, indexer latency, history depth, and per-call candle limit.
- **GeckoTerminal:** free, pool-specific OHLCV, timeframes 1/5/15/30/60m. It does not return candles for intervals without trades; use the gap-fill rule in Section 5.3.
- **`onchain_ticks` (in-house):** build local candles from the pool active bin using Helius WebSocket. It is fast and independent of third parties, but reflects that pool only.
- Backfill and gap-fill candles from the active provider at startup, restart, disconnect, timeframe change, or provider change.
- **Shadow mode (dry-run):** calculate Meteora and `onchain_ticks` in parallel with GMGN, including USD and SOL series variants; record signals and indicator differences. Use the results to choose the final source and unit.

### 5.2 Indicator exit rule (evaluated on every candle close)

```
candle  = the most recently closed candle for the active timeframe
rsi_ok  = RSI(period=2).value(candle) > 90
bb_ok   = close(candle) > BollingerUpper(candle)          // BB 20 / 2.0
macd_ok = hist(candle) > 0 AND hist(candle-1) <= 0        // first green histogram, MACD 12/26/9

signal  = rsi_ok AND (bb_ok OR macd_ok)
```

- Require at least two indicators: either (1) RSI(2) > 90 plus candle close above the BB Upper line, or (2) RSI(2) > 90 plus the MACD first green histogram. RSI(2) > 90 is mandatory.
- All conditions must occur on the **same candle**.
- Evaluate one signal per candle series, then apply it to each eligible position using that series. Identify a series by `(provider, asset_key, timeframe, price_unit)`; `asset_key` is a token mint for GMGN and a pool public key for pool-specific providers.
- **Idempotency:** one evaluation per unique `(series_key, candle_time)`; one close trigger per unique `(position, series_key, candle_time)`.

### 5.3 Candle-series rules

1. **One series = one provider and one unit.** If provider or unit changes, backfill the entire series. Never merge candles from two providers.
2. **Final candles only.** Candle N is final when candle N+1 appears or the grace window expires (default 60 seconds).
3. **Gap fill.** Fill an interval without trades with a flat candle (O=H=L=C=previous close, volume 0). Verify parity with the GMGN chart during dry-run.
4. **Warm-up per indicator.** Minimum candle counts: RSI ≥20, BB ≥20, MACD ≥35+. Do not evaluate a rule that needs an unready indicator; report “warming up” (important for new tokens). Target backfill: at least 200 candles.
5. **Stale data.** If every provider has failed for more than 5 minutes, alert and pause indicator evaluation. OOR triggers continue because they depend only on the on-chain active bin.
6. **Candle time.** Use provider UTC epoch boundaries. WIB is UTC+7, so 5m/15m/30m/1h boundaries fall on the same minute in both zones (for example, 14:00–14:15 WIB = 07:00–07:15 UTC). Indicator calculations are unaffected by time zone. Display candle ranges in WIB.

### 5.4 Indicator-trigger eligibility

A position is **eligible** when it belongs to the agent wallet, remains open, is not ignored, and the signal candle closes after `first_seen_at + min_age` (default one candle). Per-position ignore applies to both indicator and OOR triggers. A position remains eligible for an indicator signal even if it has 100% SOL exposure.

### 5.5 Indicator parameters

| Parameter | Default | Notes |
|---|---|---|
| `timeframe` | 15m | 5m / 15m / 30m / 1h; change via `/tf`, persist selection in SQLite |
| RSI period / threshold | 2 / 90 | Wilder smoothing |
| Bollinger Bands | 20 / 2.0 | Default, confirmed by user |
| MACD | 12 / 26 / 9 | Default, confirmed by user |
| Evaluation | Candle close only | Intra-candle evaluation is a v1.1 candidate |
| `min_age_candles` | 1 | See Section 5.4 |
| `grace_window_sec` | 60 | See Section 5.3 |

### 5.6 Change timeframe dynamically

A `/tf` change is stored in SQLite, resets and backfills the series, and starts a new warm-up. The new indicator policy becomes active once its series is ready. After restart, the Telegram-selected timeframe overrides the `config.json` default. Positions remain monitored; OOR continues during the transition.

### 5.7 OOR (out-of-range) trigger — force close

All distances are in bins; a higher bin ID means a higher price:

```
below_distance = lower_bin_id(position) - active_bin_id  // > 0: price below range
above_distance = active_bin_id - upper_bin_id(position)  // > 0: price above range

trigger_below : below_distance >= below.trigger_bins   // default 20
trigger_above : above_distance >= above.trigger_bins   // default 20
```

The 20-bin distance is measured from the corresponding position range boundary, not from the active bin when the position was opened.

**Meaning for single-sided SOL positions:**

- **Lower OOR:** the position is 100% token (it bought while price fell). This is the downside safety net; close and swap the token back to SOL, usually at a loss.
- **Upper OOR:** the position is 100% SOL (price moved above its range), with no token-price exposure and usually no token proceeds to swap. Close the position once the distance threshold is reached.

**Evaluation:**

- Run live, without waiting for candle close. Check every active-bin update from Helius WebSocket `LbPair` for all positions in that pool.
- `confirm_sec` is the continuous duration an OOR condition must persist, not the check/polling interval. Start the timer on the first active-bin update at or beyond 20 bins. Reset it if distance falls below 20 before the timer expires. If monitoring starts while a position is already at least 20 bins OOR, start its timer immediately; do not wait for price to re-enter the range.
- OOR is independent of candle providers and indicator warm-up, and continues while GMGN is down or a new token lacks history. If WebSocket disconnects, poll `getActiveBin` every `oor_fallback_poll_interval_sec` for pools with open positions until WebSocket recovers.
- Always honor per-position ignore. In `dry_run`, simulate and record the close (“would close”).
- Post-close swap behavior is governed globally by `swap.enabled` (Section 6 F5); there is no per-trigger close-only setting.

**Separate lower/upper parameters:**

| Parameter | `below` | `above` | Notes |
|---|---:|---:|---|
| `enabled` | true | true | Can be overridden per pool |
| `trigger_bins` | 20 | 20 | Distance from the position range boundary |
| `confirm_sec` | 5 | 30 | User-confirmed; lower side is faster, upper side is less urgent |

**Bin-to-percentage conversion:** per-bin price multiplies by `(1 + binStep/10000)`. Twenty bins are approximately `(1 + binStep/10000)^20 - 1`: bin step 80 ≈17%, 100 ≈22%, 200 ≈49%. The same bin threshold represents different price distances across pools; `trigger_bins` can be overridden per pool (Section 10.3).

## 6. Functional requirements

### F1 — Position discovery and monitoring

- Auto-discover all DLMM positions for the wallet using SDK `getUserPositions`; optionally use the Meteora DLMM Data API (`dlmm.datapi.meteora.ag`), then verify on-chain. Positions created through the Meteora UI are compatible.
- Poll every 60 seconds and after close events. Automatically register newly detected positions with default policy.
- Store pool, base-token mint/CA, quote-token mint, `lower_bin_id`, `upper_bin_id`, and `first_seen_at` per position.
- Per-position ignore is absolute for both trigger types. New positions default to `ignored = false`. `/ignore <position>` and `/unignore <position>` update `positions.ignored` in SQLite and persist across restarts; ignored position IDs do not live in config.
- Ignored positions remain visible in `/positions` but cannot trigger closes. Re-check ignore before preparing/sending a transaction. A transaction already broadcast cannot be cancelled by an ignore command.
- After unignore, indicator evaluation resumes on the next candle. If OOR is already active, start its confirmation timer from zero.
- Acceptance: detect new positions within 60 seconds; miss zero eligible positions; send zero close transactions for ignored positions.

### F2 — Price and candle engine

- Pluggable providers; apply the series rules in Section 5.3 and use `candles.price_unit`.
- Meteora has no native 15m timeframe. Build it from three 5m candles only when all candle boundaries align to :00/:15/:30/:45 and all three candles are final. Aggregate exactly: open = first candle open, high = maximum high, low = minimum low, close = last candle close, volume = sum. Use native data for 30m/1h.
- Poll closed candles every 20–30 seconds within provider rate limits; calculate GMGN load from active pool count × polling frequency against approximately 2 requests/second.
- Automatically backfill and gap-fill; retain compact candles for signal audit.
- Acceptance: in `onchain_ticks` mode, close price deviates <0.01% from on-chain price; in GMGN mode, indicator values differ <1% from manual chart values; reconnect <10 seconds without lost candles.

### F3 — Indicator and signal engine

- Implement RSI(2), BB(20,2), and MACD(12,26,9) as pure functions with unit-test calibration vectors against TradingView/GMGN (Wilder RSI(2) is required).
- Evaluate Section 5.2 on each candle close. Emit evidence including RSI, BB, MACD, close, candle time, provider, and unit.
- Debounce to one evaluation per candle close per series; apply the result to positions using that series.

### F3b — OOR trigger engine

- Subscribe to the active bin for each pool with positions (Helius WSS), calculate `below_distance` and `above_distance` per position, and apply confirmation (Section 5.7).
- Acceptance: send trigger to execution within `confirm_sec + 2s` of the threshold being reached, including at startup when already beyond threshold; execute zero closes for ignored positions.

### F4 — Fully automatic close

For each eligible position when an indicator or OOR trigger fires:

1. Re-fetch on-chain state (still open, liquidity/fees exist, owned by wallet, not ignored); for OOR, re-check bin distance. Re-check ignore before transaction send.
2. Simulate transaction (remove 100% liquidity, `shouldClaimAndClose = true`; final SDK method depends on pinned version). Abort if simulation fails.
3. Set compute-unit limit and priority fee (fixed or Helius estimate, with cap).
4. If `dry_run = false`, sign → pre-compute signature → save PENDING to SQLite → send → confirm. In dry-run, do not sign or send; record a virtual close result.
5. Record base-token and SOL amounts received from transaction metadata (pre/post balance delta); F5 uses these amounts. In dry-run, store estimates as virtual results, not realized amounts.
6. Live: update CONFIRMED/FAILED and report trigger reason, token/SOL received, fees/rewards claimed, signature, and Solscan link to Telegram. Dry-run: record virtual status and estimated result without a transaction signature.
7. Retry failures up to 3 times with backoff and refreshed blockhash. On final failure, send a CRITICAL alert and keep monitoring the position for both trigger types.
- Edge cases: single-sided positions; if no liquidity remains but fees are outstanding, still claim and close (SDK ≥1.9.3).
- Acceptance: close success rate ≥99%; zero double-sends; restart mid-transaction does not lose results (reconcile PENDING at startup).

### F5 — Auto-swap token to SOL

Start after F4 reaches CONFIRMED.

In dry-run, start F5 after recording the virtual close result. Request Jupiter Swap V2 build data for its quote; do not sign or send a swap transaction.

- Global switch `swap.enabled`: `true` runs the rules below for all close reasons; `false` records `SWAP_SKIPPED_DISABLED` and leaves close proceeds in the wallet (close-only). Skip quote and swap steps when false.
1. **Swap only the base tokens received from that close transaction**, capped at actual balance. Never touch other wallet token balances.
2. **Output SOL only** (auto-unwrap); block swaps to other tokens in code.
3. Request a Jupiter token → SOL quote. USD value = `outAmount (SOL) × SOL/USD price`.
   - ≥$0.50: attempt swap.
   - <$0.50: set `SWAP_SKIPPED_DUST`, report it, and leave the tokens.
4. Do not impose a maximum price-impact guard. If a route/quote exists and close proceeds meet the dust threshold, attempt the swap. Record quoted and realized price impact and include it in reports.
5. Slippage starts at `slippage_bps`, increases across retries up to `max_slippage_bps` (proposed values are in `config.example.json`).
6. Live: request a fresh Jupiter Swap V2 `/build` response for each attempt, assemble and simulate the versioned transaction, sign, pre-compute the signature and save PENDING, then send and confirm through the configured RPC. Retry at most 3 times. Dry-run stores the quote estimate and never signs or sends.
7. No route, frozen token, or honeypot: set `SWAP_NO_ROUTE` and alert. Provide `/retryswap` for a manual retry.
8. Per-position Telegram report: SOL from close + SOL from swap = **total SOL returned**.
9. Optional `close_empty_token_account` (default false): close empty token accounts to recover rent.
- Swap is a **separate**, non-atomic transaction after close; price can move between the two transactions.
- Acceptance: zero swaps outside close proceeds; zero double-swaps; restart mid-swap does not lose results.

### F6 — Telegram notifications and commands

- Alerts: indicator signal with evidence; OOR detected/confirmed/reset (active bin, range boundary, distance); close started/sent/confirmed/failed; swap started/confirmed/skipped/disabled/failed; warming up; position added/removed; position ignored/unignored; stale candle data/recovery; close circuit breaker opened/recovered; critical error; low SOL balance; rejected invalid config.
- V1 commands: `/status`, `/positions` (including bin distance to range and ignore state), `/tf <5m|15m|30m|1h>` (persisted in SQLite), `/ignore <position>`, `/unignore <position>`, `/retryswap <position>`, `/golive` (two-step confirmation), and journal commands: `/history [n]`, `/trade <id>`, `/stats [7d|30d|all]`, `/note <id> <text>`, `/tag <id> <tag>`, `/export`.
- Provide a persistent Telegram keyboard with a `Menu` button that lists available commands and a `Top Trending` button. `/menu` shows the same command list; the `Top Trending` button and `/toptrending` command display the configured number of qualifying tokens (default 10) according to F10. This does not initiate a buy, swap, or LP action.
- `/ignore` and `/unignore` write to SQLite immediately and confirm the change in Telegram.
- Visual reference: `referensi desain yolow.png` and `DESIGN_SYSTEM.md`. Use a dark Telegram look, compact wallet-summary card, and two-column inline menu. Buttons may only map to Yolow features; do not copy unrelated reference-bot features such as opening LPs, DCA, referrals, or other chains.
- Security: whitelist Telegram `chat_id`.
- **Displayed time:** Telegram timestamps use WIB in `DD MMM YYYY HH:mm:ss WIB` format (the actual bot copy uses Indonesian month names); candle times appear as ranges.

### F7 — Config and state

- Keep all non-secret parameters in one `config.json` (Section 10); secrets live in `.env`. Fail fast at startup if required `.env` values are missing or config schema validation fails.
- **Hot reload:** validate `config.json` before applying it. Reject invalid changes, keep the prior config, and send a Telegram alert. Changing `mode.dry_run` from true to false is not allowed through hot reload; require restart or `/golive`.
- SQLite is the runtime state store (Section 9).
- `timezone` (default `Asia/Jakarta`) controls displayed times and daily schedules, independent of server OS time zone (Section 10.4).

### F8 — Operations

- Default `dry_run = true` for the first release. Run indicator signals, OOR triggers, simulated closes, and **swap quotes** without sending real transactions. Record proposed actions as virtual trades (F9).
- Enable candle shadow mode (Section 5.1) during dry-run.
- Structured logging (pino) with rotation; graceful shutdown; full startup reconciliation (PENDING close/swap, positions closed without a final swap).
- Optional daily Telegram heartbeat at local WIB time (`notify.heartbeat.at_time`, default 08:00 WIB).

### F9 — Trade history and journal

**Goal:** each position managed by the agent produces one complete record in one place, the SQLite file `data/yolow.db`, so the user can review and learn from it.

*Trade definition:* one position lifecycle, from discovery (or opening) until close and swap completion. Maintain one `trade_history` row per position, update it through `trade_events`, and finalize it when the swap reaches a terminal state. In dry-run, record a **virtual trade** (`mode = dry_run`) with hypothetical results (position value at trigger and swap quote estimate) to assess the rules before live mode. Record triggers that do not execute (ignored, warming up, ineligible, dust) in `triggers` with an `outcome`.

*Trade record fields (`trade_history`):*

| Group | Fields |
|---|---|
| Identity | `trade_id`, `mode` (live/dry_run), position, pool, pair symbol, token mint, `bin_step`, `shape_inferred` (Spot/Curve/Bid-Ask inferred from liquidity distribution), free-form tags and notes |
| Entry | `opened_at` (on-chain), `first_seen_at`, `entry_source` (`onchain_history` or `first_seen_snapshot`), initial SOL capital, `lower_bin`/`upper_bin`/range width, active bin at entry, price (SOL and USD), entry **MarketCap USD** (price × supply), entry SOL/USD |
| During holding | duration, **time-in-range %**, maximum/minimum position value in SOL (**MFE/MAE**) and maximum drawdown, maximum/minimum active bin, range exit/re-entry count, claimed fees/rewards, `manual_changes_detected` (manual liquidity add/remove) |
| Exit | `exit_at`, `trigger_reason` (`INDICATOR`/`OOR_BELOW`/`OOR_ABOVE`), `trigger_detail` (RSI/BB/MACD values, close, candle time, provider, unit, or bin distance and confirmation duration), active bin, exit price and MarketCap USD, close signature, SOL and tokens received, network fees (base + priority fee) |
| Swap | status, signature, input token, SOL output, quote vs realized (**actual slippage**), price impact, remaining dust (USD) |
| Result | `total_sol_returned`, `pnl_sol`, `pnl_pct`, `pnl_usd` (using SOL/USD at entry and exit), reason if PnL cannot be calculated |
| After exit | price at +15m, +1h, +4h, +24h vs exit; highest and lowest price in the 24 hours after exit |
| Learning context | active `config_snapshot`, summary of `trade_candles` (N latest candles and indicators), shadow-mode difference (GMGN vs on-chain) when enabled |

*PnL rules:*
```
total_sol_returned = SOL from close + SOL from swap
pnl_sol            = total_sol_returned - initial_sol_capital - network_fees
```

Account rent (deposit and refund) is neutral and recorded separately. Get initial capital from position deposit/withdraw history (candidate sources: portfolio/position endpoints in the Meteora DLMM Data API, whose docs mention position history and portfolio PnL, or parse on-chain transactions; verify endpoint names and data completeness during implementation). If unavailable, use the value snapshot at `first_seen`, set `entry_source = first_seen_snapshot`, and mark PnL as estimated. If manual liquidity is added/removed, adjust capital and mark `manual_changes_detected`.

*Post-exit tracking:* `PostExitTracker` schedules price records at +15m, +1h, +4h, and +24h after exit. Persist the schedule in the database across restarts; obtain prices from a candle provider or on-chain source. If price is unavailable (pool is dead), store `null` with a reason. This supports analysis of whether an exit was early, timely, or late.

*Snapshots while holding:* every `snapshot_interval_sec` (default 60 seconds), `PositionMonitor` stores the active bin, SOL/token composition, and SOL position value in `position_snapshots`. Calculate MFE/MAE and time-in-range from these snapshots.

*History access (one source of truth, three access methods):*

1. **Telegram:** `/history` (recent trade summary), `/trade <id>` (full details), `/stats` (trade count, win rate, average and total PnL, average duration, breakdown by `trigger_reason` and pool), `/note`, `/tag`, and `/export` (send CSV).
2. **Automatic CSV:** update `exports/trades.csv` after each finalized trade (one row per trade, readable in Excel/Google Sheets).
3. **SQLite file:** open with a SQLite viewer (e.g. DB Browser for SQLite or Datasette), preferably read-only. Provide SQL views: `v_trades_flat`, `v_stats_by_trigger`, `v_stats_by_pool`, `v_stats_by_week`, `v_post_exit_quality`.

*Journal time:* store timestamps as UTC epoch and display in WIB: `*_wib` columns in `v_trades_flat`, CSV time columns labeled "(WIB)" in `YYYY-MM-DD HH:mm:ss` format, and WIB timestamps in `/trade` and `/history`. Group daily/weekly statistics using the 00:00 WIB day boundary (week begins Monday). Post-exit marks are relative to exit time in minutes and are unaffected by time zone.

*Retention and backup:* keep trade data (`trade_history`, `trade_events`, `triggers`) permanently. Apply configurable retention (`history.*_retention_days`) to `position_snapshots` and non-trade candle audit data. Run a daily automatic backup (`VACUUM INTO`) at `history.backup.at_time` WIB (default 03:00 WIB), use WIB timestamps in filenames, and retain a limited number of copies. Perform journal writes in SQLite WAL transactions alongside transaction records to avoid partially recorded trades.

*Acceptance criteria:*

- Every agent-closed position (live or virtual) has a finalized `trade_history` row with all required fields populated or a reasoned `null`.
- Per-trade SOL flows match on-chain wallet balance changes within ≤0.001 SOL.
- A restart mid-lifecycle neither loses nor duplicates trades; reconcile at startup.
- `/stats` and CSV numbers match direct SQL query results.

### F10 — Top Trending token discovery

**Goal:** let the user browse recently established, high-activity tokens that have at least one qualifying Meteora DLMM pool. This is read-only market discovery and is separate from position monitoring and execution.

- Telegram exposes a menu button named **`Top Trending`** and the `/toptrending` command. Show 10 tokens by default; `top_trending.limit` controls the count and can be changed in `config.json`.
- Discover candidates only from the paginated Meteora DLMM pools listing (`GET https://dlmm.datapi.meteora.ag/pools`). Consider DLMM pool details only; do not combine candidates or pool metrics from DAMM, DBC, or other DEXs.
- Only consider pools containing the wrapped SOL mint and display the other side as `TOKEN/SOL`; exclude non-SOL quote pairs such as `TOKEN/USDC`.
- Exclude common quote assets (WSOL, USDC, and USDT) as token candidates; they may still appear as the quote side of the displayed DLMM pair.
- Apply all filters before taking the top `limit` results. Defaults: MarketCap ≥ USD 500,000; token age from 6 hours through 60 days; holders ≥ 1,000; DLMM pool type only; pool TVL ≥ USD 10,000; Jupiter Organic Score ≥ 70. The age is measured from Jupiter `firstPool.createdAt`; tokens older than 60 days are excluded.
- Use Meteora DLMM data for candidate pools, pool TVL, 24-hour volume, token MarketCap, and holder count. Enrich token-level age and Organic Score from Jupiter Tokens API V2. Define age as elapsed time since Jupiter `firstPool.createdAt`; a token with missing required data cannot pass the filter.
- Enrich selected mints from GMGN AI `GET /v1/market/rank` for Solana, using `history_highest_market_cap` (USD). Compare GMGN ATH MarketCap with the current Meteora MarketCap shown for the token: drawdown percent = `(ATH MC - current MC) / ATH MC * 100`. Do not derive ATH from OHLCV.
- Default rank order is qualifying DLMM pool 24-hour volume, descending. If a token appears in multiple qualifying DLMM pools, list the mint once and represent it with its qualifying pool having the highest 24-hour volume. Continue paging/filtering until `limit` unique matches are found or the candidate pages are exhausted.
- Each result shows rank, name/symbol, the full mint/CA and pool address in separate copyable Telegram code entities, current MarketCap, GMGN ATH MarketCap and percent below ATH, token age (hours), holder count, SOL-quoted DLMM pair, pool TVL, Jupiter Organic Score, 24-hour volume, and data refresh time in WIB. If GMGN does not return that mint or a valid ATH value, show ATH and drawdown as `N/A`; do not block an otherwise eligible token.
- Query the GMGN Solana market rank once per Top Trending request, at `interval=24h`, sorted by volume, up to the documented maximum of 100 results. Match rank items to Meteora candidates by mint address. Tokens not present in those results show `N/A`.
- If required source data is missing or an API is unavailable, do not treat unknown values as passing filters. Report that results are unavailable or partial and identify the source; never imply the filters were fully applied.
- Acceptance: every displayed result satisfies all configured thresholds, only DLMM pools are represented, duplicate mints are removed, results are ranked by 24-hour pool volume descending, and this feature cannot submit a trade or close/swap transaction.
- If fewer than `limit` unique tokens pass all filters after the candidate pages are exhausted, show the available matches and state how many qualified; do not relax filters to fill the list.

## 7. Architecture

```
            ┌──────────────────────── Yolow Agent (Node.js / TypeScript) ──────────────────────────┐
 Helius WSS │ PriceFeeder ──> CandleAggregator ──> IndicatorEngine ──> SignalEngine ─┐              │
 (LbPair)──▶│   (active bin)   (ticks→OHLCV)        (RSI/BB/MACD)                    │ trigger       │
            │      │                                                                  ▼              │
            │      └──> OorTriggerEngine (live active bin, confirmation) ──> ExecutionEngine       │
            │                                                                     (close, DLMM SDK) │
            │ candle providers: GMGN ▸ Meteora ▸ GeckoTerminal ▸ ticks                │             │
            │ PositionMonitor (60s)                                                    ▼             │
            │      │                                                           SwapEngine ──▶ Jupiter│
            │      │                                                           (token → SOL)        │
            │      └─────────────────▶ StateStore (SQLite) ◀── audit / status / PENDING             │
            │                                   │                          Solana mainnet           │
            │                               Notifier ◀── command ── Telegram bot                    │
            └──────────────────────────────────────────────────────────────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| CandleProvider | Fetch OHLCV from active provider; backfill and gap-fill; finalize candles; one series per provider/unit |
| CandleAggregator | Normalize and store candles per timeframe; handle timeframe changes; shadow mode |
| IndicatorEngine | Pure/testable RSI(2), BB, MACD; per-indicator warm-up |
| SignalEngine | Section 5.2 rule, dedupe by `(position, candle_time)`, emit signal and evidence |
| **OorTriggerEngine** | Per-position live bin distance, confirmation, emit OOR trigger (Section 5.7) |
| PositionMonitor | Position discovery/reconciliation, persistent ignore flag, `min_age` |
| ExecutionEngine | Build/simulate/sign/send/confirm close; retry; single-flight; circuit breaker |
| SwapEngine | Quote/build/send token → SOL swap, dust threshold, retry, reconciliation; record price impact without a guard |
| StateStore | SQLite: position registry, ignore flags, signals/triggers, transaction audit, position state machine |
| Notifier | Telegram alerts and commands |
| ConfigLoader | Load and validate `config.json`; safe hot reload; reject invalid changes |
| **JournalService** | Build `trade_history` from events; position snapshots and candle context; CSV export; statistics; backups |
| **PostExitTracker** | Persistently schedule price marks at +15m/+1h/+4h/+24h after exit |
| **TopTrendingService** | Discover Meteora DLMM pool candidates, apply token/pool filters, enrich Jupiter token age and Organic Score, and format ranked results for Telegram (F10) |

Implementation folder structure and data flow follow `ARCHITECTURE.md`; visual consistency and bot message patterns follow `DESIGN_SYSTEM.md`.

**Per-position state machine:**

Live: `MONITORING → TRIGGERED → CLOSE_PENDING → CLOSED → SWAP_PENDING → SWAPPED | SWAP_SKIPPED_DISABLED | SWAP_SKIPPED_DUST | SWAP_NO_ROUTE | SWAP_FAILED`.

Dry-run: `MONITORING → TRIGGERED → VIRTUAL_CLOSED → DRY_RUN_QUOTED` or an applicable skip status. A failed close returns to `MONITORING`. `trigger_reason` is `INDICATOR` | `OOR_BELOW` | `OOR_ABOVE`.

## 8. Integrations and data sources

| Need | Source | Notes |
|---|---|---|
| Live pool price and active bin | **Helius WSS** `accountSubscribe` LbPair | Push updates, approximately zero credits; HTTP `getActiveBin` fallback only when WSS is down |
| Pool and position state | **`@meteora-ag/dlmm` SDK** (pin ≥1.9.3) | `create`, `getActiveBin`, `getUserPositions`, remove liquidity + claim + close |
| Position discovery (lower cost) | Optional REST `dlmm.datapi.meteora.ag` | Verify on-chain via SDK; old host `dlmm-api.meteora.ag` has been replaced |
| Primary OHLCV candles | **GMGN AI API** (user-provided key) | Approximately 2 requests/second; endpoint and units need confirmation (Open Question 1) |
| Fallback candle source 1 | **Meteora DLMM Data API** `/pools/{pool}/ohlcv` | Official, no key, 30 requests/second; 5m/30m/1h/2h/4h/12h/24h (build 15m from 5m); verify details in an implementation spike |
| Fallback candle source 2 | **GeckoTerminal OHLCV API** | Pool-specific; 1/5/15/30/60m |
| Top Trending candidates and pool metrics | **Meteora DLMM Data API** `/pools` | Paginated DLMM pools; use pool TVL/24h volume and token MarketCap/holders; filter before limiting results |
| Top Trending age and Organic Score | **Jupiter Tokens API V2** | Enrich candidate token mints with `firstPool.createdAt` and `organicScore`; requires `JUPITER_API_KEY` |
| Top Trending ATH MarketCap | **GMGN AI OpenAPI** `GET /v1/market/rank` | Read `history_highest_market_cap` for matching Solana mints; requires `GMGN_API_KEY`; uses read-only `X-APIKEY`, timestamp, and client ID |
| Final candle fallback | **On-chain ticks** (in-house) | Aggregate active-bin updates into local candles; convert to USD when `price_unit = usd` |
| **Token → SOL swaps** | **Jupiter Swap V2 Router** (`/build`) | `api.jup.ag/swap/v2/build` returns quote and instructions; Yolow assembles, simulates, signs, and broadcasts using its own RPC and configured priority-fee cap |
| SOL/USD price | Jupiter (SOL→USDC quote or Price API) | Used for $0.50 threshold and on-chain-series conversion; confirm final source during implementation |
| RPC | **Helius Free** (HTTP + WSS) | Approximately 1M credits/month, 10 RPS |
| Priority fee | Helius `getPriorityFeeEstimate` or fixed | Capped; used for close and swap |
| Notifications/commands | **Telegram Bot API** | Bot token from @BotFather |

**Estimated Helius credits:** WSS push ≈0 (including OOR); position discovery once/minute ≈43k/month; fallback polling while WSS is down <50k/month; close and swap transactions are few; total **<150k credits/month** out of 1M. Continuous `getActiveBin` polling every 5 seconds would use ≈500k/month: avoid it; poll only during WSS outages.

## 9. SQLite data model

**Time convention:** store every timestamp as **UTC epoch milliseconds** (source of truth, aligned with on-chain/provider timestamps and independent of server time zone). Convert to WIB for Telegram, CSV, SQL views, and logs. Indonesia has no DST; WIB stays UTC+7.

- `positions` — public key, pool, base/quote token mints, lower/upper bin, `first_seen_at`, state (Section 7), `ignored`, `ignore_updated_at`, `last_checked`
- `triggers` — ID, position, pool, `trigger_reason` (`INDICATOR`/`OOR_BELOW`/`OOR_ABOVE`), detected/confirmed times, JSON details (RSI/BB/MACD/close or active bin/distance), action taken; indicator uniqueness by `(position, series_key, candle_time)`
- `signals` — `series_key`, `asset_key`, provider, timeframe, unit, candle time, rule fired, RSI, BB upper, close, MACD histogram, evaluation time; unique `(series_key, candle_time)`
- `transactions` — signature, kind (`CLOSE`/`SWAP`), position, pool, status (PENDING/CONFIRMED/FAILED), attempts, error, sent/confirmed times
- `close_results` — position, trigger reason, base tokens received, SOL received, fees claimed, rewards claimed
- `swaps` — ID, position, input mint/amount, quoted SOL lamports, estimated USD value, slippage bps, price impact, status (PENDING/CONFIRMED/DRY_RUN_QUOTED/SKIPPED_DISABLED/SKIPPED_DUST/NO_ROUTE/FAILED), signature, SOL received
- `candles` (optional audit) — provider, token/pool, timeframe, unit, open time, OHLCV
- `meta` — active timeframe (config default or Telegram selection), close circuit breaker state, config version, backfill cursor

**Journal tables (F9):**

- `trade_history` — one row per trade (fields in F9); includes `mode`, `entry_source`, `pnl_sol`, `config_snapshot`, tags, notes
- `trade_events` — append-only timeline per trade: `trade_id`, timestamp, type (DETECTED, TRIGGER_CONFIRMED, CLOSE_SENT, CLOSE_CONFIRMED, SWAP_SENT, SWAP_FINAL, POST_EXIT_MARK, NOTE, etc.), JSON payload
- `position_snapshots` — position, timestamp, active bin, SOL/token amount, SOL value, `in_range`
- `trade_candles` — candle and indicator values frozen at trigger (N recent candles)
- `post_exit_marks` — trade, offset minutes, due time, SOL/USD price, percent vs exit, status
- `triggers.outcome` — EXECUTED | DRY_RUN | IGNORED | NOT_ELIGIBLE | WARMING_UP | SKIPPED, so non-executed signals remain analyzable
- SQL analysis views: `v_trades_flat`, `v_stats_by_trigger`, `v_stats_by_pool`, `v_stats_by_week`, `v_post_exit_quality`

## 10. Configuration and environment

### 10.1 Environment and secrets (`.env`) — never in `config.json`

| Variable | Required | Purpose |
|---|---|---|
| `HELIUS_API_KEY` | Yes | HTTP + WSS RPC |
| `GMGN_API_KEY` | Yes if GMGN candles or Top Trending ATH are enabled | GMGN key for candle data and/or Top Trending ATH MarketCap |
| `JUPITER_API_KEY` | Yes if `swap.enabled` or `top_trending.enabled` | Jupiter API key for Swap API and/or Tokens API V2, as required by host/plan |
| `AGENT_WALLET_PUBKEY` | Yes | Monitored agent wallet public key; required in dry-run and live |
| `AGENT_KEYPAIR_PATH` | Live mode only | Path to keypair JSON outside repository; `.env` stores only the path |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Whitelisted chat ID |
| `CONFIG_PATH` | Optional | Defaults to `./config.json` |
| `DB_PATH` | Optional | Defaults to `./data/yolow.db` |

Required practices: add `.env` to gitignore from the first commit (commit only `.env.example`); fail fast when required variables are missing; redact secrets in logs; restart after `.env` changes. Keep API keys out of `config.json` so it can be safely shared, committed, and diffed.

Dry-run needs no keypair. In live mode, the public key derived from the keypair must match `AGENT_WALLET_PUBKEY`. Never put a raw private key in `.env`, config, logs, SQLite, or Telegram. Store the keypair file outside the repository with read permissions restricted to the agent process user.

### 10.2 `config.json` (one file for all parameters)

The complete example is `config.example.json`. Main sections:

| Block | Contents |
|---|---|
| `config_version` | Schema version for migrations |
| `timezone` | Display/schedule time zone (default `Asia/Jakarta`, WIB/UTC+7) |
| `mode` | `dry_run`, `shadow_candles`, position polling interval |
| `rpc` | HTTP/WSS base URLs (no key), OOR fallback polling interval |
| `candles` | Primary/fallback providers, `price_unit`, polling, grace window, backfill, provider settings |
| `indicator_exit` | `enabled`, default timeframe, `min_age_candles`, RSI/BB/MACD parameters, rule structure |
| `oor_exit` | Evaluation and separate `below`/`above` blocks (Section 5.7) |
| `pool_overrides` | Per-pool overrides (Section 10.3) |
| `execution` | Priority fee and cap, close retry |
| `swap` | `enabled`, `min_value_usd`, slippage, retries, `close_empty_token_account`; record price impact with no rejection cap |
| `top_trending` | Enabled state, result limit, and MarketCap/age/holders/TVL/Organic Score thresholds |
| `jupiter` | Swap API and Tokens API V2 base URLs |
| `notify` | Low SOL balance threshold and heartbeat (WIB time) |
| `history` | Journal enablement, virtual trades, snapshot interval, retention, candle context count, post-exit schedule, CSV export, backups |
| `logging` | Log level |

Position ignore flags and the active Telegram-selected `/tf` value are runtime state in SQLite, not `config.json`. Config `indicator_exit.timeframe` is the default only when no Telegram selection has been saved.

File rules:

- Strict JSON (no comments). This document explains parameters; every value is defined in `config.example.json`.
- Validate schema at startup and on every hot reload (types, ranges, enums). Examples of rejection: `trigger_bins < 1`, unsupported timeframe, `swap.output` other than `SOL`, `top_trending.limit < 1`, `top_trending.min_holders` not an integer, or an Organic Score threshold outside 0–100.
- Safe hot reload: reject invalid changes and alert while keeping the previous configuration. A `mode.dry_run: true → false` change cannot take effect through hot reload (Section 6 F7).
- Audit active `config.json` changes (old → new values) without secrets.

### 10.3 Per-pool overrides

Deep-merge `pool_overrides` on top of defaults. Example:

```json
"pool_overrides": {
  "<pool_pubkey>": {
    "indicator_exit": { "timeframe": "5m" },
    "oor_exit": { "below": { "trigger_bins": 30 }, "above": { "enabled": false } }
  }
}
```

Main use: adjust `trigger_bins` for pool bin step and set a per-pool timeframe.

### 10.4 Time zone: WIB (UTC+7, Asia/Jakarta)

- **All displayed user-facing time uses WIB:** Telegram, CSV, journal SQL views, application logs, `/stats`, and backup filenames.
- Configure `timezone` in `config.json`, default `Asia/Jakarta` (IANA name validated at startup). Always use the explicit configured zone; never depend on server OS time zone (VPS is commonly UTC).
- **Internal storage:** UTC epoch milliseconds; convert to WIB only for display (Section 9).
- **Display format:** Telegram `03 Oct 2026 14:05:12 WIB`; CSV `2026-10-03 14:05:12` with headers suffixed "(WIB)"; logs use ISO-8601 offset `+07:00` (e.g. `2026-10-03T14:05:12.000+07:00`). The actual bot copy uses Indonesian month names.
- **Daily local WIB schedules:** backup `history.backup.at_time` (default `03:00`), heartbeat `notify.heartbeat.at_time` (default `08:00`), daily statistics boundary `00:00` WIB, week starts Monday at `00:00` WIB.
- **Candles:** see Section 5.3 item 6. Timeframes 5m–1h are unaffected. If 4h or daily timeframes are added later, follow provider boundaries (a UTC daily candle starts at 07:00 WIB).
- **Third parties:** Solscan and some APIs display UTC; Yolow displays converted WIB.
- **Tests:** UTC↔WIB conversion at day boundary (23:59 → 00:00 WIB), week boundary, and year change.

## 11. Reliability and safety

- Keep `dry_run` ON for at least 1–2 weeks in the first release to calibrate indicator parity, OOR behavior, and candle-source selection.
- Simulate before sending; pre-compute and persist signatures before sending both close and swap transactions.
- **Single-flight per position:** only one active transaction per position, even if indicator and OOR triggers fire simultaneously.
- Retry up to 3 times with backoff. **Close circuit breaker:** stop automatic close sends after 3 consecutive close failures and send a CRITICAL alert. Swap failure does not stop trigger detection.
- Cap priority fees; check ownership; re-check ignore immediately before sending close.
- Swap only close proceeds; output is fixed to SOL; never touch other wallet token balances.
- On candle source failure, fall back and backfill the series. If all providers fail for >5 minutes, alert and pause indicator evaluation until recovery; keep OOR active.
- Store API keys and bot token in `.env`; live keypair file stays outside repository. `.env` stores only the keypair path, never the private key. Use a dedicated wallet: all managed positions must be opened from the agent wallet, and its keypair grants full authority over that wallet.
- Alert on low SOL (gas + rent); whitelist Telegram `chat_id`; reject invalid config.
- **Protect the journal:** SQLite WAL transactions, daily backups with limited retention, append-only `trade_events`; alert on backup or CSV export failure. Database and backups must not contain secrets.

## 12. Non-functional requirements

- Node.js 20+ / TypeScript; pin `@meteora-ag/dlmm` ≥1.9.3; `@solana/web3.js`; better-sqlite3; pino; grammy; vitest; config schema validation (e.g. zod).
- **Latency targets (proposed):**
  - Indicator trigger with `onchain_ticks`: candle close → close transaction sent within **10 seconds**.
  - Indicator trigger with GMGN/GeckoTerminal: **p95 ≤45 seconds** (depends on provider candle finalization; measure during dry-run).
  - OOR trigger: after `confirm_sec` expires, send close transaction within **5 seconds**.
  - After close confirmation, send swap transaction within **15 seconds**.
- Uptime ≥99% (PM2/Docker + automatic restart); graceful shutdown; full startup reconciliation.
- Journal storage estimate: several tens of MB per month for ~10 open positions with 60-second snapshots; snapshot and candle audit retention configurable under `history`.

## 13. Success metrics

1. During 1–2 weeks of dry-run, agent signals match the manually observed GMGN MarketCap chart (mismatch <1%); record and have the user assess indicator-signal and OOR-trigger frequency per pool/day.
2. Document shadow-mode differences (GMGN vs on-chain; USD vs SOL series) to select the source and unit.
3. Close success rate ≥99%; **zero double closes**; **zero execution on ignored positions**; **zero swaps outside close proceeds**.
4. **Zero missed OOR triggers** in active-bin replay tests; verify that positions already beyond 20 bins at startup close after the configured confirmation period, and that ignored positions never close.
5. 100% of close proceeds worth ≥$0.50 end as SOL or produce an explicit alert.
6. Meet Section 12 latency targets; Helius credit consumption <20% of monthly quota.
7. **Complete journal:** every trade has a final record; PnL matches on-chain balance within ≤0.001 SOL; post-exit marks filled ≥95% (otherwise reasoned `null`); user can query win rate by `trigger_reason`, average Spot vs Curve results, and how often price rises again after exit.
8. **Consistent time:** every user-facing Telegram/CSV/SQL/log timestamp is WIB and matches UTC-epoch conversion, verified automatically including 00:00 WIB day boundaries.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Continuous decline/rug:** lower OOR is a last-resort safety net, not a tight stop-loss. A wide-range position can already have a large loss before price crosses the lower boundary and then still wait 20 more bins | Lower OOR trigger (default 20 bins); per-pool `trigger_bins`; value-based loss limit is a v1.1 candidate |
| Price falls rapidly (gap) beyond the threshold before execution | Cannot be fully prevented; live evaluation, short lower-side `confirm_sec`, ≤5-second execution latency after confirmation |
| A brief wick causes an unintended close | `confirm_sec` and reset when price returns below the threshold |
| **Swap fails, has no route, token is frozen/honeypot, or price impact is large during a dump** (especially after lower OOR) | Still attempt swap without impact guard; progressive slippage, limited retries, record impact, explicit status/alert, `/retryswap` |
| A position intentionally placed far away is closed after reaching 20-bin OOR | This is the selected behavior; manually exclude it with `/ignore` |
| Agent indicators differ from GMGN chart (Wilder RSI(2), histogram color, USD vs SOL, supply changes) | Calibration vectors, shadow mode, dry-run parity |
| GMGN is volume-gated and public OHLCV endpoint is undocumented | Pluggable provider and fallbacks; confirm access when key is ready (Open Question 1) |
| Aggregate GMGN token candles differ from the DLMM pool price | Measure divergence in shadow mode |
| Unverified Meteora Data API behavior (current candle, empty intervals, memecoin price units, indexer latency, no 15m); quiet pools may have sparse candles and wicks | Verification spike; Section 5.3 series rules; aggregate 5m→15m; shadow mode; keep providers pluggable |
| False signal from mixed providers, gaps, or new tokens | Apply Section 5.3 series rules |
| New position closes immediately on an old indicator signal | `min_age` in Section 5.4 |
| Price moves between non-atomic close and swap transactions | Swap within 15s; record difference; atomic close+swap is a future candidate |
| Failed transaction, expired blockhash, sandwich | Simulation, retry with refreshed blockhash, priority-fee cap; specialized send path (e.g. Helius Sender/Jito) after v1 |
| Incorrect/extreme `config.json` edit or accidental live mode | Schema validation, reject + alert, allow `dry_run=false` only via restart/`/golive` |
| Hot wallet compromise | Dedicated wallet, minimal balance, keypair outside repository |
| Helius WebSocket disconnect/rate limit | Reconnect and gap-fill; poll only as fallback |
| SDK bug (close fails with outstanding fees) | Pin ≥1.9.3; integration test with small position |
| Initial capital unknown for positions opened before agent startup, or changed by manual deposits/withdrawals | `entry_source` and estimated flag; detect `manual_changes_detected`; do not mix estimated PnL without labeling |
| Conclusions biased by small samples or hindsight (exit looks “wrong” only because price later rose) | Show sample count; use post-exit marks for trends, not as a verdict on one trade |
| Journal loss (VPS disk failure) or database corruption | Daily backups, WAL + transactions, CSV copy, alert on backup failure |

## 15. Roadmap

- **V1 (MVP):** F1–F9, including F3b upper/lower OOR; dry-run default + shadow mode; token→SOL auto-swap; dynamic timeframe; validated `config.json`; SQLite + full audit; F9 journal through Telegram, CSV, and backups.
- **V1.1:** manual `/close <position>`; value-based triggers (loss limit %, time-based); automatic weekly Telegram report; optional Google Sheets sync; intra-candle early exit; atomic close+swap.
- **V2:** automatic re-entry, rebalancing, journal dashboard with charts, backtesting using journal data.

## 16. Confirmed decisions

| Decision | Source |
|---|---|
| Target token-memecoin/SOL pools, single-sided SOL, Spot/Curve | User |
| Chart read by user is MarketCap | User |
| Primary candle source GMGN; fallback Meteora → GeckoTerminal → on-chain ticks | User |
| Fully automatic close without manual confirmation | User |
| Exit signal: RSI(2) > 90 + (candle close > BB Upper **or** MACD first green histogram), on the same candle | User |
| Monitor every wallet position; manage ignore flags in Telegram and persist them in SQLite | User |
| `/tf` changes active timeframe and persists it in SQLite; RSI/BB/MACD parameters use defaults and are not changed in Telegram | User |
| `swap.enabled = false` means close-only; when true, swap close proceeds to SOL if value ≥$0.50 | User |
| Never reject a swap because of price impact; record quoted/realized impact | User |
| Force close when lower or upper OOR reaches 20 bins from its range boundary; indicator signals also close 100% SOL positions | User |
| OOR confirmation: 5 seconds below and 30 seconds above; reset if distance falls below 20 bins | User |
| Keep all parameters in one `config.json` | User |
| Record complete trade history in one place for later study | User |
| All displayed times use WIB (GMT+7, Asia/Jakarta) | User |
| Store timestamps as UTC epoch and convert to WIB for display | PRD |
| Default timeframe is 15m and can be changed dynamically | User |
| Notifications and commands via Telegram | User |
| USD price series (equivalent to USD MarketCap indicators when supply is constant) | PRD recommendation; verify with GMGN docs (Open Question 1) |
| Dry-run is the default for first release | PRD |
| Derive token CA/mint automatically from each position pool | PRD |
| `Top Trending` is a read-only Telegram feature; default to 10 qualifying Meteora DLMM tokens and apply all configured filters | User |
| Top Trending token age must be from 6 hours through 60 days | User |

## 17. Open questions

**A. Technical inputs needed later:**

1. **GMGN API access.** When available, provide (a) K-line/OHLCV endpoint documentation, (b) one successful JSON response, (c) rate limits and plan quota, and (d) whether values are price or MarketCap and USD or SOL.

**B. Proposed defaults (correct if needed):**

2. BB 20/2.0, MACD 12/26/9; “first green histogram” means histogram changes from ≤0 to >0.
3. Indicator triggers only on **candle close**; intra-candle early exit deferred to v1.1.
4. Swap slippage starts at 500 bps and increases up to 1500 bps; no price-impact guard; 3 retries.
5. Deploy on a 24/7 Linux VPS with a dedicated wallet (all managed positions opened from that wallet).

**C. Trade journal defaults:**

6. **History access:** V1 uses Telegram + automatic CSV + direct SQLite access. Google Sheets sync is v1.1 and web dashboard is v2. Is this sufficient, or is one needed earlier?
7. Report PnL primarily in **SOL** (USD as supporting data).
8. Retention: trade data permanent; position snapshots 180 days; non-trade candle audit 60 days; daily backups, retain 14 copies.
9. Daily WIB schedule: backup **03:00 WIB**, heartbeat **08:00 WIB** (heartbeat disabled by default).

**D. Candle source decision after dry-run:**

10. Select GMGN (matches the user’s MarketCap chart) or Meteora (same pool as the position, official, no key) as primary. Current default is GMGN when access exists; otherwise, or if divergence from the chart is large, promote Meteora. Decide using shadow-mode RSI/BB/MACD differences and signal timing.

**E. Top Trending defaults:**

11. Confirm that `$500.000K` means USD 500,000 and `$10.000K` means USD 10,000.
12. Proposed default ranking is 24-hour DLMM pool volume descending; token age is measured from Jupiter `firstPool.createdAt`. Confirm if a different ranking window or age source is preferred.

## 18. Glossary

- **Candle close:** the moment a candle finishes (e.g. the 15m candle ending at 10:15 WIB); indicator triggers are evaluated only then.
- **Intra-candle (early exit):** evaluate while a candle is still forming; faster but vulnerable to transient spikes and false signals.
- **Bin / active bin:** discrete DLMM price unit; active bin contains the current market price. Higher bin ID means higher price.
- **OOR (out of range):** active bin is outside a position bin range. Below = position is 100% token; above = position is 100% SOL.
- **Parity:** agent indicator values match the user-visible GMGN chart.
- **Shadow mode:** calculate two data sources/series in parallel for comparison only; do not use them for execution.
- **Warm-up:** minimum candle count required before an indicator becomes valid.
- **Dust:** token remainder worth less than the $0.50 swap threshold; do not swap it.
- **Single-sided SOL:** LP position containing only SOL initially; it converts into tokens as price falls and back into SOL as price rises.
- **Trade:** one position lifecycle from discovery/opening through close and swap; one `trade_history` row.
- **Virtual trade:** hypothetical trade recorded in `dry_run`, with no real transaction.
- **MFE / MAE:** highest and lowest position value during holding (the unrealized gain/loss reached before exit).
- **Time-in-range:** percentage of time the market price is inside the position range, where fees are earned.
- **Post-exit mark:** price recorded some time after exit to evaluate exit timing.
- **WIB:** Western Indonesian Time = UTC+7, `Asia/Jakarta`; no daylight saving time.

## 19. References

- DLMM SDK: https://github.com/MeteoraAg/dlmm-sdk · https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/getting-started · https://www.npmjs.com/package/@meteora-ag/dlmm (fixed `shouldClaimAndClose` in ≥1.9.3)
- Helius: https://docs.helius.dev · https://helius.dev/pricing
- Jupiter Swap V2 build API: https://developers.jup.ag/docs/swap/build
- Jupiter Tokens API V2: https://developers.jup.ag/docs/tokens/token-information
- GMGN API (Cooperation API, volume-gated): https://docs.gmgn.ai · chart embed `https://www.gmgn.cc/kline/{chain}/{token}`
- Meteora DLMM Data API: https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview · OHLCV: https://docs.meteora.ag/api-reference/dlmm/pools/ohlcv
- Meteora DLMM pools listing: https://docs.meteora.ag/api-reference/dlmm/pools/pools
- GeckoTerminal API (OHLCV): https://www.geckoterminal.com/dex-api
- Telegram Bot API: https://core.telegram.org/bots/api
