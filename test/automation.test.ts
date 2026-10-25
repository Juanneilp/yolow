import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "../src/meteora.ts";
import { parseConfig } from "../src/config/config.ts";
import { openDatabase, setMeta } from "../src/storage/db.ts";
import { SOL_MINT } from "../src/positions/monitor.ts";
import { PaperAutomation } from "../src/automation/automation.ts";
import { AutomationMarket, paperModel, markPaper, type Market, type Snapshot } from "../src/automation/market.ts";
import { exitReason, spotRange, swapAllowed } from "../src/automation/rules.ts";
import type { Notification, TelegramMessage } from "../src/telegram/client.ts";
import { createCommandHandler } from "../src/telegram/commands.ts";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const mint = key(1), pool = key(2), source = key(3);
const config = () => {
  const value = parseConfig(readFileSync("config.example.json", "utf8"));
  value.automation.enabled = true;
  return value;
};
const bin = { id: 0, x: "0", y: "500000000", supply: "0", price: (1n << 64n).toString(), feeX: "0", feeY: "0" };
function harness(t: any) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const cfg = config();
  const snapshot: Snapshot = { at: Date.now(), active: 0, step: 80, solIsX: false, mint, bins: [bin] };
  const calls = { screening: 0, entry: 0, holding: 0, quotes: [] as bigint[], failQuote: false, dust: false };
  let pools: any[] = [];
  const market: Market = {
    snapshot: async () => ({ ...snapshot, at: Date.now() }),
    entry: async () => {
      calls.entry++;
      return { snapshot: { ...snapshot, at: Date.now() }, lower: -201, upper: 0, rent: 10n, gas: 1n,
        model: paperModel([bin], [{ binId: 0, amountX: new BN(0), amountY: new BN(500000000) }]) };
    },
    holding: async () => { calls.holding++; return { sol: 250000000n, token: 100n, rent: 10n }; },
    quote: async (_mint, amount) => {
      calls.quotes.push(amount);
      if (calls.failQuote) throw new Error("quote offline");
      return { sol: amount * 1000000n, gas: 2n, valueMicrousd: calls.dust ? 199999n : 200000n, at: Date.now() };
    },
    walletToken: async () => 200n,
    walletSol: async () => 20_000_000_000n,
    gas: () => 1n,
  };
  const sent: TelegramMessage[] = [];
  const options = { db, config: cfg, market, apiKey: "test", price: () => ({ ...snapshot, at: Date.now() }),
    discover: async () => true, notify: async (message: Notification) => {
      assert.equal(typeof message, "object"); sent.push(message as TelegramMessage);
    },
    pnl: { refresh: async () => new Map([[pool, { fetchedAt: Date.now(), positions: new Map([[source,
      { deposits: 0.5, withdrawals: 0, claimed: 0, percent: 10 }]]) }]]) } as any,
    screening: (async (criteria: any, _key: string, _base: string, _tokens: string, filters: any) => {
      calls.screening++;
      assert.ok(criteria.min_market_cap_usd >= 1500000 && criteria.min_token_age_days >= 3 && criteria.min_tvl_usd >= 5000);
      assert.equal(filters.minBinStep, 80);
      return { pools: pools.filter((item) => !filters.excludedMints.has(item.mint)), limited: false };
    }) as any,
  };
  const automation = new PaperAutomation(options);
  const real = (id = source, p = pool, m = mint) => db.prepare(`INSERT INTO positions
    (id,pool,token_mint,quote_mint,lower_bin_id,upper_bin_id,first_seen_at,last_checked)
    VALUES(?,?,?,?,0,10,0,0)`).run(id, p, m, SOL_MINT);
  const candidates = (values = [{ address: pool, mint, symbol: "TOKEN", binStep: 80 }]) => { pools = values; };
  const delta = (m = SOL_MINT) => BigInt((db.prepare("SELECT delta FROM automation_balances WHERE mint=?").get(m) as any)?.delta ?? 0);
  return { db, cfg, snapshot, calls, market, options, automation, real, candidates, delta, sent };
}

test("SPOT range stays on SOL side in either orientation and approaches -80% within one bin", () => {
  for (const solIsX of [false, true]) {
    const range = spotRange(1000, 80, solIsX, -80);
    assert.equal(solIsX ? range.lower : range.upper, 1000);
    const ratio = Math.pow(1.008, -(range.upper - range.lower));
    assert.ok(ratio >= 0.2 && ratio / 1.008 < 0.2);
  }
  assert.throws(() => spotRange(0, 79, false, -80));
  assert.throws(() => spotRange(0, 80, false, -100));
});

test("exit percentages compound from range boundaries in both orientations and require fresh prices", () => {
  for (const solIsX of [false, true]) {
    const input = { active: solIsX ? -1 : 11, lower: 0, upper: 10, step: 1000, solIsX, principal: 10000n, profit: 500n, ignored: false, at: Date.now() };
    assert.equal(exitReason(input, config().automation), "OOR_ABOVE_PERCENT");
    input.active = solIsX ? 14 : -4;
    assert.equal(exitReason(input, config().automation), "OOR_BELOW_PERCENT");
    input.active = 5;
    assert.equal(exitReason(input, config().automation), "TAKE_PROFIT");
    input.profit = 499n;
    assert.equal(exitReason(input, config().automation), undefined);
    input.profit = 1000n; input.at -= 120001;
    assert.equal(exitReason(input, config().automation), undefined);
    input.at = Date.now(); input.ignored = true;
    assert.equal(exitReason(input, config().automation), undefined);
  }
  assert.equal(swapAllowed(199999n, 0.2), false);
  assert.equal(swapAllowed(200000n, 0.2), true);
});

test("paper liquidity uses integer shares, accrues only new fees, and preserves empty active-bin allocation", () => {
  const model = paperModel([bin], [{ binId: 0, amountX: new BN(0), amountY: new BN(500000000) }]);
  const snapshot = { at: Date.now(), active: 0, step: 80, solIsX: false, mint, bins: [bin] };
  assert.deepEqual(markPaper(model, snapshot), { sol: 500000000n, token: 0n });
  assert.deepEqual(markPaper(model, { ...snapshot, active: -1 }), { sol: 0n, token: 500000000n });
  const liquid = { ...bin, supply: (1000n << 64n).toString(), y: "1000" };
  const shares = paperModel([liquid], [{ binId: 0, amountX: new BN(0), amountY: new BN(100) }]);
  assert.deepEqual(markPaper(shares, { ...snapshot, bins: [{ ...liquid, feeY: (1n << 64n).toString() }] }), { sol: 200n, token: 0n });
  assert.throws(() => markPaper(model, { ...snapshot, at: Date.now() - 120001 }));
});

test("16 manual positions block all screening and entry work; simulations never free real slots", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 16; i++) h.real(key(i + 10), pool, mint);
  h.candidates();
  await h.automation.tick();
  assert.equal(h.calls.screening, 0); assert.equal(h.calls.entry, 0);
  assert.match(h.automation.status(), /Slot 16\/15/);
});

test("entries reserve unique pools and mints, debit principal/rent/gas once, and survive restart", async (t) => {
  const h = harness(t);
  h.candidates([{ address: pool, mint, symbol: "TOKEN", binStep: 80 }, { address: key(20), mint, symbol: "TOKEN", binStep: 80 }]);
  await Promise.all([h.automation.tick(), h.automation.tick()]);
  assert.equal(h.calls.entry, 1);
  assert.equal(h.automation.list()[0].state, "OPEN");
  assert.equal(h.delta(), -500000011n);
  const restarted = new PaperAutomation(h.options);
  await restarted.tick();
  assert.equal(restarted.list().length, 1); assert.equal(h.calls.entry, 1);
  assert.equal(h.db.prepare("SELECT count(*) n FROM transactions").get()!.n, 0);
});

test("entry rechecks real positions after awaits and releases reservations if discovery races", async (t) => {
  const h = harness(t); h.candidates();
  h.options.discover = async () => {
    if (h.calls.entry) h.real();
    return true;
  };
  await h.automation.tick();
  assert.equal(h.automation.list().length, 0); assert.equal(h.delta(), 0n);
  assert.equal(h.db.prepare("SELECT count(*) n FROM positions").get()!.n, 1);
});

test("upper OOR replaces a virtual position in the same eligible pool before lower-ranked alternatives", async (t) => {
  const h = harness(t); h.candidates();
  await h.automation.tick();
  const first = h.automation.list()[0];
  h.snapshot.active = 13;
  h.candidates([{ address: key(20), mint: key(21), symbol: "OTHER", binStep: 80 }, { address: pool, mint, symbol: "TOKEN", binStep: 80 }]);
  h.cfg.automation.max_positions = 1;
  await h.automation.tick();
  assert.equal(h.automation.list(false).find((row) => row.id === first.id)?.reason, "OOR_ABOVE_PERCENT");
  assert.equal(h.automation.list()[0].pool, pool);
  assert.notEqual(h.automation.list()[0].id, first.id);
  assert.equal(h.automation.blocks().length, 0);
});

test("15 slots include ignored manual positions and an entry reservation during asynchronous checks", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 14; i++) h.real(key(i + 10), key(50), key(51));
  h.db.prepare("UPDATE positions SET ignored=1").run();
  h.candidates();
  const entry = h.market.entry;
  h.market.entry = async (...args) => {
    assert.match(h.automation.status(), /Slot 15\/15/);
    return entry(...args);
  };
  await h.automation.tick();
  assert.equal(h.automation.list()[0].state, "OPEN");
  assert.match(h.automation.status(), /Slot 15\/15/);
});

test("unknown/nonzero entry fees release the reservation without changing simulation balances", async (t) => {
  const h = harness(t); h.candidates();
  h.market.entry = async () => { throw new Error("non-refundable fee"); };
  await h.automation.tick();
  assert.equal(h.automation.list().length, 0); assert.equal(h.delta(), 0n);
});

test("lower OOR loss sweeps the full wallet, excludes old balance from profit and leaves the real position OPEN", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50;
  await h.automation.tick();
  const paper = h.automation.list(false)[0];
  assert.equal(paper.state, "CLOSED"); assert.equal(paper.reason, "OOR_BELOW_PERCENT");
  assert.deepEqual(h.calls.quotes, [300n]);
  assert.deepEqual(h.automation.blocks().map((item) => item.mint), [mint]);
  assert.equal(h.delta(mint), -200n);
  assert.equal(h.delta(), 550000007n);
  const trade = h.db.prepare("SELECT * FROM trade_history").get()!;
  assert.ok(String(trade.position_id).startsWith("paper:"));
  assert.equal(trade.pnl_sol, -0.150000004);
  assert.equal(trade.swap_sol_received, 0.1);
  assert.equal(h.db.prepare("SELECT state FROM positions").get()!.state, "OPEN");
  const recovered = new PaperAutomation(h.options);
  await recovered.tick(); assert.deepEqual(h.calls.quotes, [300n]);
  recovered.unblock(mint); assert.equal(recovered.blocks().length, 0);
});

test("failed swap resumes after restart without reclosing or double crediting and cannot unblock prematurely", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50; h.calls.failQuote = true;
  t.mock.method(console, "warn", () => {});
  await h.automation.tick();
  assert.equal(h.automation.list()[0].state, "CLOSING");
  assert.equal(h.delta(), 250000009n);
  assert.throws(() => h.automation.unblock(mint), /belum selesai/);
  h.calls.failQuote = false;
  const recovered = new PaperAutomation(h.options);
  await recovered.tick(); await recovered.tick();
  assert.equal(h.calls.holding, 1); assert.equal(h.delta(), 550000007n);
  assert.equal(h.db.prepare("SELECT count(*) n FROM trade_history").get()!.n, 1);
});

test("close notifications follow committed states and never replay after completion", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50;
  const states: string[] = [];
  const notify = h.options.notify;
  h.options.notify = async (message) => {
    states.push(h.automation.list(false)[0].state);
    await notify(message);
  };
  await h.automation.tick();
  assert.deepEqual(states, ["CLOSING", "CLOSED"]);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0].text, /CLOSE SIMULASI DIMULAI/);
  assert.match(h.sent[0].text, /Stop loss OOR bawah/);
  assert.match(h.sent[0].text, /Posisi manual/);
  assert.match(h.sent[1].text, /CLOSE SIMULASI SELESAI/);
  assert.match(h.sent[1].text, /−0,15000000 SOL/);
  assert.match(h.sent[1].text, /Quote simulasi berhasil/);
  assert.match(h.sent[1].text, /Posisi nyata tetap terbuka dan memakai slot/);
  assert.match(h.sent[1].text, /Saldo token lama tidak dihitung/);
  assert.doesNotMatch(h.sent[1].text, /OOR_BELOW_PERCENT|DRY_RUN_QUOTED/);
  const closed = h.automation.list(false)[0];
  await (h.automation as any).beginClose(closed, { sol: 1n, token: 1n }, "OOR_BELOW_PERCENT");
  await (h.automation as any).finishClose(closed);
  await new PaperAutomation(h.options).tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.delta(), 550000007n);
});

test("pending swap notice is persisted once across retries and restarts, followed by one final result", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50; h.calls.failQuote = true;
  t.mock.method(console, "warn", () => {});
  await h.automation.tick(); await h.automation.tick();
  const recovered = new PaperAutomation(h.options);
  await recovered.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text, /SWAP SIMULASI TERTUNDA/);
  assert.equal(h.db.prepare("SELECT count(*) n FROM automation_events WHERE type='SWAP_WAITING'").get()!.n, 1);
  h.calls.failQuote = false;
  await recovered.tick(); await recovered.tick();
  assert.equal(h.sent.length, 3);
  assert.match(h.sent[2].text, /CLOSE SIMULASI SELESAI/);
  assert.equal(h.calls.holding, 1);
});

test("failed close state transaction emits no start notification or simulated credits", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50;
  t.mock.method(console, "warn", () => {});
  h.db.exec(`CREATE TEMP TRIGGER reject_paper_close BEFORE UPDATE OF state ON automation_positions
    WHEN NEW.state='CLOSING' BEGIN SELECT RAISE(ABORT,'mock commit failure'); END;`);
  await h.automation.tick();
  assert.equal(h.sent.length, 0); assert.equal(h.delta(), 0n);
  assert.equal(h.db.prepare("SELECT count(*) n FROM automation_events WHERE type='CLOSE_STARTED'").get()!.n, 0);
  assert.equal(h.automation.blocks().length, 0);
});

test("failed notification delivery cannot stop close completion or turn a committed entry into a skipped entry", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50;
  t.mock.method(console, "warn", () => {});
  h.options.notify = async () => { throw new Error("Telegram offline"); };
  await h.automation.tick();
  assert.equal(h.automation.list(false)[0].state, "CLOSED");
  assert.equal(h.delta(), 550000007n);
  h.db.prepare("UPDATE positions SET state='CLOSED'").run();
  h.snapshot.active = 0;
  h.candidates([{ address: key(41), mint: key(42), symbol: "OTHER", binStep: 80 }]);
  h.market.entry = async () => ({ snapshot: { ...h.snapshot, mint: key(42), at: Date.now() }, lower: -201, upper: 0,
    rent: 10n, gas: 1n, model: [] });
  (h.automation as any).lastScreen = 0;
  await h.automation.tick();
  assert.equal(h.automation.list()[0].state, "OPEN");
  assert.equal(h.db.prepare("SELECT count(*) n FROM automation_events WHERE type='ENTRY_SKIPPED'").get()!.n, 0);
});

test("entry and dust completion cards distinguish virtual funds, costs and unswapped tokens", async (t) => {
  const h = harness(t); h.candidates([{ address: pool, mint, symbol: "<TOKEN>", binStep: 80 }]);
  await h.automation.tick();
  assert.match(h.sent[0].text, /ENTRY VIRTUAL/); assert.match(h.sent[0].text, /&lt;TOKEN&gt;\/SOL/);
  assert.match(h.sent[0].text, /0,50000000 SOL/); assert.match(h.sent[0].text, /Rent refundable/);
  assert.match(h.sent[0].text, /Non-refundable/); assert.equal(h.sent[0].parseMode, "HTML");
  assert.ok((h.sent[0].replyMarkup!.inline_keyboard as any[][]).flat().some(b => b.callback_data?.startsWith("auto:position:")));
  h.snapshot.active = -260; h.calls.dust = true;
  await h.automation.tick();
  const result = h.sent.at(-1)!;
  assert.match(result.text, /Dilewati · nilai dust/);
  assert.match(result.text, /tanpa gas swap dan tanpa kredit SOL/);
  assert.doesNotMatch(result.text, /Quote simulasi berhasil/);
});

test("dust below $0.20 remains token, pays no swap gas and is never credited as SOL", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50; h.calls.dust = true;
  await h.automation.tick();
  assert.equal(h.delta(), 250000009n); assert.equal(h.delta(mint), 100n);
  const trade = h.db.prepare("SELECT * FROM trade_history").get()!;
  assert.equal(trade.swap_status, "SKIPPED_DUST"); assert.equal(trade.swap_sol_received, 0);
  assert.equal(trade.pnl_sol, -0.250000002);
});

test("take profit uses net SOL after entry/close/swap gas and ignores refundable rent and old wallet tokens", async (t) => {
  const h = harness(t); h.real();
  h.market.holding = async () => ({ sol: 425000000n, token: 100n, rent: 1000000000n });
  await h.automation.tick(); assert.equal(h.automation.list().length, 0);
  h.market.holding = async () => ({ sol: 425000004n, token: 100n, rent: 1000000000n });
  (h.automation as any).lastValuation = 0;
  await h.automation.tick();
  assert.equal(h.automation.list(false)[0].reason, "TAKE_PROFIT");
  assert.equal(h.db.prepare("SELECT pnl_sol FROM trade_history").get()!.pnl_sol, 0.025);
  assert.equal(h.calls.quotes.at(-1), 100n);
});

test("ignore, disabled automation and persisted LIVE prevent simulation actions", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50;
  h.db.prepare("UPDATE positions SET ignored=1").run();
  await h.automation.tick(); assert.equal(h.calls.holding, 0);
  h.db.prepare("UPDATE positions SET ignored=0").run();
  setMeta(h.db, "dry_run", "false");
  await h.automation.tick(); assert.equal(h.calls.holding, 0);
  setMeta(h.db, "dry_run", "true"); h.cfg.automation.enabled = false;
  await h.automation.tick(); assert.equal(h.calls.holding, 0);
});

test("automation config refuses LIVE, disabled swaps, unsafe slot counts and sub-$0.20 swap thresholds", () => {
  for (const change of [
    (c: any) => { c.mode.dry_run = false; },
    (c: any) => { c.swap.enabled = false; },
    (c: any) => { c.swap.min_value_usd = 0.199; },
    (c: any) => { c.automation.max_positions = 16; },
    (c: any) => { c.automation.min_bin_step = 79; },
    (c: any) => { c.automation.min_price_percent = -100; },
    (c: any) => { c.automation.oor_below_percent = 100; },
    (c: any) => { c.automation.profit_percent = 0.011; },
  ]) {
    const c = config(); change(c);
    assert.throws(() => parseConfig(JSON.stringify(c)));
  }
});

test("wallet readers reject unsafe numeric balances and wrong token ownership", async () => {
  const wallet = new PublicKey(key(8));
  const connection: any = { getBalance: async () => Number.MAX_SAFE_INTEGER + 1,
    getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: { parsed: { info: {
      owner: key(9), mint, tokenAmount: { amount: "100" },
    } } } } }] }) };
  const market = new AutomationMarket(connection, wallet, config(), "test");
  await assert.rejects(market.walletSol(), /tidak valid/);
  await assert.rejects(market.walletToken(mint), /tidak valid/);
});

test("changed ignore state during a close read and stale quotes leave balances untouched", async (t) => {
  const h = harness(t); h.real(); h.snapshot.active = -50;
  h.market.walletSol = async () => {
    h.db.prepare("UPDATE positions SET ignored=1").run();
    return 1000000000n;
  };
  await h.automation.tick();
  assert.equal(h.delta(), 0n); assert.equal(h.automation.blocks().length, 0);
  h.market.walletSol = async () => 1000000000n;
  h.db.prepare("UPDATE positions SET ignored=0").run();
  h.market.quote = async () => ({ sol: 1000000000n, gas: 1n, valueMicrousd: 200000n, at: Date.now() - 120001 });
  t.mock.method(console, "warn", () => {});
  await h.automation.tick();
  assert.equal(h.automation.list()[0].state, "CLOSING");
  assert.equal(h.delta(), 250000009n);
  assert.equal(h.db.prepare("SELECT count(*) n FROM trade_history").get()!.n, 0);
});

test("Telegram refuses LIVE while automation is active and retired settings cannot reactivate old rules", async (t) => {
  const h = harness(t);
  const handler = createCommandHandler({ db: h.db, config: h.cfg, agent: { automation: h.automation } as any,
    connection: {} as any, wallet: new PublicKey(key(9)), telegramToken: "test", chatId: "1" });
  assert.match((await handler.onCommand("/golive", []))!.text, /DRY-RUN/);
  assert.match((await handler.onCallback("golive:confirm"))!.text, /DRY-RUN/);
  assert.match((await handler.onCallback("config:section:oor"))!.text, /dihapus/);
  assert.match((await handler.onCommand("/auto", []))!.text, /SIMULASI/);
  assert.match((await handler.onCommand("/tf", []))!.text, /dihapus/);
});

test("read-only Jupiter quote uses Swap V2 taker, minimum output and fails closed on mismatched amounts", async (t) => {
  const cfg = config(), wallet = new PublicKey(key(8));
  const market = new AutomationMarket({} as any, wallet, cfg, "test");
  (market as any).decimals.set(mint, 9);
  const seen: string[] = [];
  let badAmount = false;
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const url = new URL(String(input)); seen.push(url.pathname);
    assert.equal(init.headers["x-api-key"], "test");
    if (url.pathname.includes("/price/")) return Response.json({ [SOL_MINT]: { usdPrice: 100 }, [mint]: { usdPrice: 1 } });
    assert.equal(url.searchParams.get("taker"), wallet.toBase58());
    assert.equal(url.searchParams.get("wrapAndUnwrapSol"), "true");
    assert.equal(url.searchParams.get("amount"), "200000000");
    assert.equal(url.searchParams.get("userPublicKey"), null);
    return Response.json({ inputMint: mint, outputMint: SOL_MINT, inAmount: badAmount ? "1" : "200000000",
      swapMode: "ExactIn", slippageBps: cfg.swap.slippage_bps, outAmount: "2100000", otherAmountThreshold: "2000000" });
  });
  const dust = await market.quote(mint, 199999999n);
  assert.equal(dust.gas, 0n); assert.equal(dust.sol, 0n); assert.equal(seen.length, 1);
  (market as any).nextJupiterAt = 0;
  const quote = await market.quote(mint, 200000000n);
  assert.equal(quote.sol, 2000000n); assert.equal(quote.valueMicrousd, 200000n);
  badAmount = true; (market as any).nextJupiterAt = 0;
  await assert.rejects(market.quote(mint, 200000000n), /tidak sesuai/);
});

test("SDK entry checks all bins, rejects bin-array/bitmap/composition/extension fees and accepts only single SOL input", async (t) => {
  const cfg = config(), wallet = new PublicKey(key(8));
  const token = { address: new PublicKey(mint), decimals: 9, tlvData: Buffer.alloc(0) };
  const sol = { ...token, address: new PublicKey(SOL_MINT) };
  let cost = { positionCount: 1, positionCost: 1, positionReallocCost: 2, binArrayCost: 0, binArraysCount: 0, bitmapExtensionCost: 0 };
  const client: any = { lbPair: { binStep: 80, activeId: 0, parameters: { functionType: 2 } }, tokenX: { mint: token }, tokenY: { mint: sol },
    clock: { epoch: new BN(0) }, quoteCreatePosition: async () => cost,
    getBinsBetweenLowerAndUpperBound: async (lower: number, upper: number) => ({ activeBin: 0,
      bins: Array.from({ length: upper - lower + 1 }, (_, n) => ({ binId: lower + n, xAmount: new BN(0), yAmount: new BN(0), supply: new BN(0), feeAmountXPerTokenStored: new BN(0), feeAmountYPerTokenStored: new BN(0) })) }) };
  t.mock.method(DLMM, "create", async () => client);
  const market = new AutomationMarket({ getMinimumBalanceForRentExemption: async () => 123 } as any, wallet, cfg, "test");
  const accepted = await market.entry(pool, 500000000n);
  assert.ok(accepted.lower < -190); assert.equal(accepted.upper, 0); assert.equal(accepted.rent, 123n);
  assert.ok(accepted.model.every((row) => row.x === "0"));
  for (const extra of [{ binArrayCost: 1 }, { binArraysCount: 1 }, { bitmapExtensionCost: 1 }, { positionCost: NaN }, { positionCount: 2 }]) {
    const original = cost; cost = { ...cost, ...extra };
    await assert.rejects(market.entry(pool, 500000000n), /non-refundable/);
    cost = original;
  }
  token.tlvData = Buffer.from([1, 0, 0, 0]);
  await assert.rejects(market.entry(pool, 500000000n), /ekstensi/);
  token.tlvData = Buffer.from([18, 0, 0, 0, 19, 0, 0, 0]);
  assert.equal((await market.entry(pool, 500000000n)).rent, 123n);
  t.mock.method(client, "getBinsBetweenLowerAndUpperBound", async (lower: number, upper: number) => ({ activeBin: 0,
    bins: Array.from({ length: upper - lower + 1 }, (_, n) => ({ binId: lower + n, xAmount: new BN(100), yAmount: new BN(100), supply: new BN(100), feeAmountXPerTokenStored: new BN(0), feeAmountYPerTokenStored: new BN(0) })) }));
  await assert.rejects(market.entry(pool, 500000000n), /Composition/);
});
