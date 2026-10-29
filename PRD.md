# Yolow product requirements

Current scope: monitor one wallet's Meteora DLMM positions and run **DRY-RUN SPOT automation** through authorized Telegram controls. The previous RSI/BB/MACD indicator exit and legacy OOR engine have been removed, including timers, overrides and `/tf` controls. Current automation uses bin-distance OOR exits. Historical records remain readable. Top Trending is removed; Top Careless remains the shared screening source.

## Entry

- TOKEN/SOL pools only, single-side SOL; both mint orientations supported.
- SPOT, 0.5 SOL principal, min price −80%, max price 0% from entry. Map to discrete bins inside the boundary, within one bin; one extended position, maximum 1,400 bins. Minimum bin step 80.
- Never enter if any non-refundable opening fee is nonzero or unknown. Inspect the complete range for new bin arrays and bitmap cost; reject uncertain composition/transfer fees and unsupported token extensions. Network gas is permitted. Refundable position rent is separate from principal/profit and must be budgeted.
- Screening: MCAP ≥$1.5M, token age ≥3 days from Jupiter firstPool, TVL ≥$5K. Rank Simple Fee/TVL 24h, then volume, then pool address. Formula: volume × base fee percentage ÷ TVL. APR comparison is Fee/TVL percentage ×365, excluding farm rewards.
- Exclude active mint/pool duplicates and blocked loss tokens before the result limit. Scan at most 20×100 pools; report limited coverage. UI defaults to ten results; automation uses all eligible scanned results, minimum bin step and mint exclusions.
- Maximum 15 includes every actual position, ignored positions, virtual positions and reservations. A simulated manual close does not free the actual slot. If above the cap, monitor exits and wait for real capacity.
- Fresh discovery before entry and again before commit, atomic slot/duplicate/budget checks, reserve during asynchronous work. Failed entry removes the reservation without debit. Skip screening/fee/entry quotes when full.

## Exits and replacement

Apply to virtual and actual manual TOKEN/SOL positions; honor ignore state. Actual manual size/bin step/range are retained.

| Priority | Trigger | Result |
| --- | --- | --- |
| 1 | Lower OOR distance ≥20 bins from the crossed range boundary | Simulate loss close; block mint until manual unblock; screen another token |
| 2 | Net SOL PnL ≤−50% of principal | Simulate loss close; sweep the wallet mint, block it and screen another token |
| 3 | Upper OOR distance ≥10 bins from the crossed range boundary | Simulate close; prefer same pool only if all entry requirements still pass |
| 4 | Net SOL profit ≥5% of principal | Simulate close; select replacement through screening |

OOR counts the current bin distance from the crossed boundary, inclusive at the threshold, independent of bin step. Normalize direction for token price in SOL on X/Y; invert bin direction when SOL is X. Do not count cumulative bin movements or use the entry bin. Parameters are `automation.oor_above_bins` (10) and `automation.oor_below_bins` (20), both safe positive integers; discard old percentage settings without converting their values. Pending percentage closes finish with their original sweep/reentry behavior; historical records are not rewritten. Old `oor_exit` controls remain retired. Use fresh data only. Price feed is WS plus default 15-second fallback, exit evaluation every 15 seconds, PnL valuation every 60 seconds and additionally before upper OOR exits, screening every five minutes or after close.

The DRY-RUN `STOP_LOSS` reason uses `automation.stop_loss_percent`, default 50, hot-editable with >0 to 100 and at most two decimals. Compare integer lamports using basis points; −50% includes the exact boundary and scales with each position principal. Missing or stale PnL/quotes cannot trigger it; upper OOR remains available if valuation fails. No LIVE stop-loss implementation or schema migration is added. The threshold is a trigger, not a guaranteed final loss.

Net profit = close SOL + minimum SOL quote for position tokens + historical withdrawn/claimed SOL − principal − estimated entry/close/swap gas. Quotes include slippage; exclude rent and old wallet balances. Manual positions without a complete fresh basis cannot take profit or stop loss automatically, but OOR still works in simulation. Existing PnL reminders are separate lifetime estimates before liquidation fees.

## Swaps and loss blocks

All swaps output SOL and require minimum value **$0.20**, inclusive. Smaller balances remain dust, incur no swap gas and are not realized SOL. Quotes must match requested mint, integer amount, exact-in mode and configured slippage. Fail closed on unavailable/malformed/stale quotes.

After lower OOR loss or PnL stop-loss, the user authorizes swapping the **entire wallet balance of that mint**, including preexisting tokens. This release simulates the sweep only. Allocate the position's share separately; old-token proceeds must not inflate LP profit. Other exits swap only position tokens.

Failed swaps remain CLOSING and retry without a second close or duplicate credits. Persist mint blocks; `/auto unblock <mint>` permits future screening after the pending swap resolves. Unblocking does not bypass entry criteria.

Manual blacklist: `/blacklist` lists full mint CAs; `/blacklist add <CA>` and `/blacklist remove <CA>` manage one address at a time. Persist in `top_careless.blacklisted_mints` with an empty default and immediate application. Validate Solana address format locally and match case exactly. Exclude all matching pools from Top Careless before result limits and block automatic entry/reentry, including an entry still undergoing checks. Continue monitoring and exits for existing positions. Manual blacklist and loss blocks are independent; removing either never clears the other. Existing screening messages update on Refresh.

## Dry-run accounting and recovery

- No automatic signing, broadcasting or real balance changes. No LIVE entry implementation in this release.
- Config and SQLite mode must be DRY-RUN. Refuse automation startup with persisted LIVE; block `/golive` and its callback while active.
- Persist virtual positions, bin allocation/share/fee model, principal, gas, refundable rent, ledger offsets, loss blocks, pending swaps and preferred reentry pool.
- Atomically OPEN → CLOSING with close holdings/credits, then CLOSING → CLOSED with swap debits/credits and one journal row. Crash recovery resumes pending work. Reservations with no debit can be released at startup.
- Journal IDs use `paper:<uuid>`; never mark actual positions CLOSED or route paper IDs to a signer. Preserve existing transaction recovery.
- Shadow model follows observed bin liquidity/fee accumulators; empty bins use ideal fills. No market impact or exact mainnet return is claimed.

## Telegram and operations

Six home actions: Status, Positions & PnL, Top Careless, Journal, Settings and Help. Eight native commands: start/menu/status/positions/topcareless/history/config/help. Persistent keyboard: Menu and Posisi & PnL, followed by full-width Top Careless.

`/auto` shows dry-run mode, real/virtual slots, strategy, balance offsets, pending swaps, token blocks and last status. `/auto unblock <mint>` reactivates a mint. Settings expose automation, execution/swap, historical data, notifications/journal, Careless and system. Old strategy/OOR/timeframe controls show removal notices.

Positions display five cards per page, largest SOL PnL first, unavailable values last. Distinguish virtual estimates and manual closes already simulated while real positions remain open. Detail supports ignore/unignore, refresh and full addresses. Preserve safe HTML screening cards, message splitting, authorization and editor cancellation.

Journal, CSV, snapshots, backups, notes/tags and historical records remain. Keep credentials in ignored `.env`, settings in ignored `config.json`, keypairs outside the repository with mode600. Retain Jupiter instruction validation, simulation, duplicate-send protection and metadata recovery. Follow [PRD_SECURITY.md](PRD_SECURITY.md).

Node ≥22.21.0; no separate build. Run `npm test`, then restart only `yolow` through PM2. Verify effective dry-run mode, process health and Telegram polling. Mainnet live execution is outside acceptance testing for this release.
