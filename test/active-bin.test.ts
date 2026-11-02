import assert from "node:assert/strict";
import test from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createProgram } from "../src/meteora.ts";
import { ActiveBinMonitor } from "../src/market-data/active-bin.ts";
import { SOL_MINT } from "../src/positions/monitor.ts";
import { openDatabase } from "../src/storage/db.ts";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
async function setup(t: any, count: number) {
  const db = openDatabase(":memory:");
  const connection = new Connection("https://mainnet.helius-rpc.com", "confirmed");
  const program = createProgram(connection, { cluster: "mainnet-beta" });
  const empty = Buffer.alloc(program.coder.accounts.size("lbPair"));
  bs58.decode(program.coder.accounts.memcmp("lbPair").bytes).copy(empty);
  const fields = program.coder.accounts.decode("lbPair", empty);
  const data = await program.coder.accounts.encode("lbPair", { ...fields, activeId: -5, binStep: 80, tokenXMint: new PublicKey(SOL_MINT) });
  const account = { data, owner: program.programId, executable: false, lamports: 1, rentEpoch: 0 };
  let pools = Array.from({ length: count }, (_, n) => key(n + 1).toBase58());
  const calls: string[][] = [];
  t.mock.method(connection, "getMultipleAccountsInfo", async (keys: PublicKey[]) => { calls.push(keys.map((key) => key.toBase58())); return keys.map(() => account); });
  const ws = t.mock.method(connection, "onAccountChange", () => { throw new Error("Unexpected WebSocket subscription"); });
  const monitor = new ActiveBinMonitor({ connection, db, fallbackPollMs: 15_000, extraPools: () => pools });
  t.after(async () => { await monitor.close(); db.close(); });
  return { db, connection, monitor, account, calls, ws, pools, setPools: (next: string[]) => { pools = next; } };
}

test("17 unique real/virtual pools use one request and decode actual SDK account data", async (t) => {
  const h = await setup(t, 17);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  h.db.prepare("INSERT INTO positions(id,pool,token_mint,quote_mint,lower_bin_id,upper_bin_id,first_seen_at,last_checked) VALUES('position',?,?,?,0,10,0,0)")
    .run(h.pools[0], key(80).toBase58(), SOL_MINT);
  h.setPools([...h.pools, h.pools[0]]);
  await Promise.all([h.monitor.poll(), h.monitor.poll()]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].length, 17);
  assert.deepEqual(h.monitor.latest(h.pools[0]), { active: -5, step: 80, solIsX: true, at: now });
  assert.equal(h.db.prepare("SELECT active_bin FROM positions").get()!.active_bin, -5);
  await h.monitor.poll();
  assert.equal(h.calls.length, 1);
  now += 15_000;
  await h.monitor.poll();
  assert.equal(h.calls.length, 2);
  assert.equal(h.ws.mock.callCount(), 0);
});

test("empty sets make no requests, 101 pools split at 100, and pool changes prune data", async (t) => {
  const h = await setup(t, 0);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await h.monitor.poll();
  assert.equal(h.calls.length, 0);
  const pools = Array.from({ length: 101 }, (_, n) => key(n + 1).toBase58());
  h.setPools(pools);
  await h.monitor.poll();
  assert.deepEqual(h.calls.map((batch) => batch.length), [100, 1]);
  h.setPools([pools[100], key(110).toBase58()]);
  now += 5_000;
  await h.monitor.poll();
  assert.equal(h.monitor.latest(pools[0]), undefined);
  assert.equal(h.calls.length, 2);
  now += 10_000;
  await h.monitor.poll();
  assert.deepEqual(h.calls[2], [pools[100], key(110).toBase58()]);
  assert.ok(h.monitor.latest(key(110).toBase58()));
});

test("failed, missing, wrongly owned and malformed accounts never refresh freshness", async (t) => {
  const h = await setup(t, 2);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "warn", () => {});
  await h.monitor.poll();
  const at = now;
  for (const bad of [null, { ...h.account, owner: key(99) }, { ...h.account, data: Buffer.alloc(0) }]) {
    now += 15_000;
    t.mock.method(h.connection, "getMultipleAccountsInfo", async () => [bad, h.account] as any);
    await h.monitor.poll();
    assert.equal(h.monitor.latest(h.pools[0])?.at, now - at <= 30_000 ? at : undefined);
    assert.equal(h.monitor.latest(h.pools[1])?.at, now);
  }
  t.mock.method(h.connection, "getMultipleAccountsInfo", async () => { throw new Error("RPC unavailable"); });
  now += 30_001;
  await h.monitor.poll();
  assert.equal(h.monitor.latest(h.pools[1]), undefined);
});

test("slow responses retain their request timestamp and shutdown waits without writing after close", async (t) => {
  const h = await setup(t, 1);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let complete!: (accounts: any[]) => void;
  t.mock.method(h.connection, "getMultipleAccountsInfo", () => new Promise((resolve) => { complete = resolve; }));
  const pending = h.monitor.poll();
  await Promise.resolve();
  now += 30_001;
  complete([h.account]);
  await pending;
  assert.equal(h.monitor.latest(h.pools[0]), undefined);
  const next = h.monitor.poll();
  await Promise.resolve();
  const closing = h.monitor.close();
  complete([h.account]);
  await Promise.all([next, closing]);
  assert.equal(h.monitor.latest(h.pools[0]), undefined);
  await h.monitor.poll();
});
