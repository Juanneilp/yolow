import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Sqlite = DatabaseSync;

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  if (path !== ":memory:" && !path.startsWith("file:")) {
    chmodSync(path, 0o600);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS config_changes (
      id INTEGER PRIMARY KEY, changed_at INTEGER NOT NULL, path TEXT NOT NULL,
      old_value TEXT NOT NULL, new_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY, pool TEXT NOT NULL, token_mint TEXT NOT NULL, quote_mint TEXT NOT NULL,
      lower_bin_id INTEGER NOT NULL, upper_bin_id INTEGER NOT NULL, first_seen_at INTEGER NOT NULL,
      ignored INTEGER NOT NULL DEFAULT 0, ignore_updated_at INTEGER, state TEXT NOT NULL DEFAULT 'OPEN',
      active_bin INTEGER, last_checked INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS positions_state_idx ON positions(state, pool);
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY, position_id TEXT NOT NULL, pool TEXT NOT NULL, reason TEXT NOT NULL,
      detected_at INTEGER NOT NULL, confirmed_at INTEGER NOT NULL, detail TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'SKIPPED', series_key TEXT, candle_time INTEGER,
      UNIQUE(position_id, reason, series_key, candle_time, confirmed_at)
    );
    CREATE TABLE IF NOT EXISTS signals (
      series_key TEXT NOT NULL, asset_key TEXT NOT NULL, provider TEXT NOT NULL, timeframe TEXT NOT NULL,
      unit TEXT NOT NULL, candle_time INTEGER NOT NULL, rule_fired INTEGER NOT NULL,
      rsi REAL, bb_upper REAL, close REAL, macd_hist REAL, evaluated_at INTEGER NOT NULL,
      PRIMARY KEY(series_key, candle_time)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      signature TEXT PRIMARY KEY, kind TEXT NOT NULL, position_id TEXT NOT NULL, pool TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, error TEXT,
      sent_at INTEGER NOT NULL, confirmed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS close_results (
      position_id TEXT NOT NULL, trigger_id INTEGER, token_mint TEXT NOT NULL,
      token_received TEXT, sol_received_lamports TEXT, fees_claimed TEXT, rewards_claimed TEXT,
      signature TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS swaps (
      id INTEGER PRIMARY KEY, position_id TEXT NOT NULL, close_signature TEXT, input_mint TEXT NOT NULL,
      input_amount TEXT NOT NULL, quoted_sol_lamports TEXT, estimated_usd REAL, slippage_bps INTEGER,
      price_impact REAL, status TEXT NOT NULL, signature TEXT, sol_received_lamports TEXT,
      error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candles (
      provider TEXT NOT NULL, asset_key TEXT NOT NULL, timeframe TEXT NOT NULL, unit TEXT NOT NULL,
      open_time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
      close REAL NOT NULL, volume REAL NOT NULL, PRIMARY KEY(provider, asset_key, timeframe, unit, open_time)
    );
    CREATE TABLE IF NOT EXISTS trade_history (
      trade_id INTEGER PRIMARY KEY, mode TEXT NOT NULL, position_id TEXT NOT NULL UNIQUE, pool TEXT NOT NULL,
      pair TEXT, token_mint TEXT NOT NULL, bin_step INTEGER, shape_inferred TEXT, tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT, opened_at INTEGER, first_seen_at INTEGER NOT NULL, entry_source TEXT NOT NULL,
      initial_sol_capital REAL, lower_bin INTEGER NOT NULL, upper_bin INTEGER NOT NULL,
      entry_active_bin INTEGER, entry_price_sol REAL, entry_price_usd REAL, entry_market_cap_usd REAL,
      entry_sol_usd REAL, exit_at INTEGER, trigger_reason TEXT, trigger_detail TEXT, exit_active_bin INTEGER,
      exit_price_sol REAL, exit_price_usd REAL, exit_market_cap_usd REAL, close_signature TEXT,
      sol_received REAL, tokens_received TEXT, network_fees_sol REAL, swap_status TEXT, swap_signature TEXT,
      swap_input_mint TEXT, swap_sol_received REAL, swap_slippage REAL, swap_price_impact REAL,
      remaining_dust_usd REAL, total_sol_returned REAL, pnl_sol REAL, pnl_pct REAL, pnl_usd REAL,
      pnl_reason TEXT, duration_sec REAL, time_in_range_pct REAL, mfe_sol REAL, mae_sol REAL,
      max_drawdown_pct REAL, max_active_bin INTEGER, min_active_bin INTEGER, range_exit_count INTEGER DEFAULT 0,
      manual_changes_detected INTEGER DEFAULT 0, config_snapshot TEXT NOT NULL, finalized_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS trade_events (
      id INTEGER PRIMARY KEY, trade_id INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL,
      payload TEXT NOT NULL, FOREIGN KEY(trade_id) REFERENCES trade_history(trade_id)
    );
    CREATE TABLE IF NOT EXISTS position_snapshots (
      position_id TEXT NOT NULL, at INTEGER NOT NULL, active_bin INTEGER NOT NULL,
      sol_amount TEXT, token_amount TEXT, sol_value REAL, in_range INTEGER NOT NULL,
      PRIMARY KEY(position_id, at)
    );
    CREATE TABLE IF NOT EXISTS trade_candles (
      trade_id INTEGER NOT NULL, candle_time INTEGER NOT NULL, provider TEXT NOT NULL,
      timeframe TEXT NOT NULL, unit TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL,
      volume REAL, rsi REAL, bb_upper REAL, macd_hist REAL,
      PRIMARY KEY(trade_id, candle_time), FOREIGN KEY(trade_id) REFERENCES trade_history(trade_id)
    );
    CREATE TABLE IF NOT EXISTS post_exit_marks (
      trade_id INTEGER NOT NULL, offset_min INTEGER NOT NULL, due_at INTEGER NOT NULL,
      price_usd REAL, percent_vs_exit REAL, status TEXT NOT NULL, reason TEXT,
      PRIMARY KEY(trade_id, offset_min), FOREIGN KEY(trade_id) REFERENCES trade_history(trade_id)
    );
    CREATE VIEW IF NOT EXISTS v_trades_flat AS
      SELECT trade_history.*, datetime(opened_at / 1000, 'unixepoch', '+7 hours') AS opened_at_wib,
        datetime(exit_at / 1000, 'unixepoch', '+7 hours') AS exit_at_wib,
        datetime(finalized_at / 1000, 'unixepoch', '+7 hours') AS finalized_at_wib FROM trade_history;
    CREATE VIEW IF NOT EXISTS v_stats_by_trigger AS
      SELECT trigger_reason, count(*) AS trades, avg(pnl_sol) AS avg_pnl_sol, sum(pnl_sol) AS total_pnl_sol
      FROM trade_history WHERE finalized_at IS NOT NULL GROUP BY trigger_reason;
    CREATE VIEW IF NOT EXISTS v_stats_by_pool AS
      SELECT pool, count(*) AS trades, avg(pnl_sol) AS avg_pnl_sol, sum(pnl_sol) AS total_pnl_sol
      FROM trade_history WHERE finalized_at IS NOT NULL GROUP BY pool;
    CREATE VIEW IF NOT EXISTS v_stats_by_week AS
      SELECT strftime('%Y-%W', datetime(finalized_at / 1000, 'unixepoch', '+7 hours')) AS week_wib,
        count(*) AS trades, avg(pnl_sol) AS avg_pnl_sol, sum(pnl_sol) AS total_pnl_sol
      FROM trade_history WHERE finalized_at IS NOT NULL GROUP BY week_wib;
    CREATE VIEW IF NOT EXISTS v_post_exit_quality AS
      SELECT offset_min, count(*) AS marks, avg(percent_vs_exit) AS avg_percent_vs_exit
      FROM post_exit_marks WHERE status = 'RECORDED' GROUP BY offset_min;
  `);
  return db;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined)?.value;
}
