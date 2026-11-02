import assert from "node:assert/strict";
import test from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { createRpcFetch, createHeliusConnection } from "../src/market-data/rpc.ts";
import { getMeta, openDatabase, setMeta } from "../src/storage/db.ts";

const url = "https://mainnet.helius-rpc.com/?api-key=never-log-this";
const request = (method = "getBalance") => ({ body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params: ["private-wallet"] }) });

const heliusOptions = (changes: Record<string, unknown> = {}) => ({
  httpBase: "https://mainnet.helius-rpc.com", wsBase: "wss://mainnet.helius-rpc.com",
  primaryKey: "primary-test", backupKey: "backup-test", onActiveSlotChange: (_slot: number) => {}, ...changes,
});
const wallet = new PublicKey(Buffer.alloc(32, 1));
const balanceResponse = (init: any) => Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { context: { slot: 1 }, value: 123 } });

test("quota exhaustion switches HTTP and WSS, retries reads, and persists only the active slot", async (t) => {
  const calls: string[] = [], slots: number[] = [], logs: string[] = [];
  t.mock.method(console, "warn", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const rpc = createHeliusConnection(heliusOptions({ onActiveSlotChange: (slot: number) => slots.push(slot) }), async (input, init) => {
    const key = new URL(String(input)).searchParams.get("api-key")!;
    calls.push(key);
    return key === "primary-test" ? new Response("max usage reached", { status: 429 }) : balanceResponse(init);
  });
  assert.equal(await rpc.connection.getBalance(wallet), 123);
  assert.deepEqual(calls, ["primary-test", "backup-test"]);
  assert.deepEqual(slots, [2]);
  assert.equal(new URL(rpc.connection.rpcEndpoint).searchParams.get("api-key"), "backup-test");
  assert.equal(new URL((rpc.connection as any)._rpcWsEndpoint).searchParams.get("api-key"), "backup-test");
  await rpc.connection.getBalance(wallet);
  assert.deepEqual(calls, ["primary-test", "backup-test", "backup-test"]);
  rpc.report();
  assert.doesNotMatch(logs.join("\n"), /primary-test|backup-test|private-wallet/);
  assert.match(logs.join("\n"), /"slot":2/);
});

test("single-key configs, duplicate keys and persisted selection are compatible", async () => {
  for (const [backupKey, activeSlot, expected] of [[undefined, 2, "primary-test"], ["  ", 2, "primary-test"],
    [" primary-test ", 2, "primary-test"], ["backup-test", 2, "backup-test"], ["backup-test", 99, "primary-test"]] as const) {
    const calls: string[] = [];
    const rpc = createHeliusConnection(heliusOptions({ backupKey, activeSlot }), async (input, init) => {
      calls.push(new URL(String(input)).searchParams.get("api-key")!); return balanceResponse(init);
    });
    assert.equal(await rpc.connection.getBalance(wallet), 123);
    assert.deepEqual(calls, [expected]);
  }
  assert.throws(() => createHeliusConnection(heliusOptions({ primaryKey: " " })), /Missing HELIUS_API_KEY/);
  assert.throws(() => createHeliusConnection(heliusOptions({ httpBase: "https://attacker.example" })), /trusted Helius/);
});

test("ordinary rate limits, invalid credentials, server errors and network failures never rotate", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const status of [429, 401, 403, 503, 0]) {
    let calls = 0;
    const rpc = createHeliusConnection(heliusOptions({ onActiveSlotChange: () => assert.fail("Unexpected rotation") }), async () => {
      calls++;
      if (!status) throw new Error("network unavailable");
      return new Response("request rejected", { status });
    });
    await assert.rejects(rpc.connection.getBalance(wallet));
    assert.equal(calls, 1);
  }
});

test("both keys exhausted stop at two attempts and recover through one cooled-down probe", async (t) => {
  let now = Date.now(), calls = 0, recover = false;
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "warn", () => {});
  const rpc = createHeliusConnection(heliusOptions(), async (_input, init) => {
    calls++; return recover ? balanceResponse(init) : new Response("max usage reached", { status: 429 });
  });
  await assert.rejects(rpc.connection.getBalance(wallet), /429/);
  assert.equal(calls, 2);
  await assert.rejects(rpc.connection.getBalance(wallet), /cooling down/);
  assert.equal(calls, 2);
  now += 60_000; recover = true;
  assert.equal(await rpc.connection.getBalance(wallet), 123);
  assert.equal(calls, 3);
});

test("broadcast switches future calls but never replays the send on the backup", async (t) => {
  t.mock.method(console, "warn", () => {});
  const calls: string[] = [];
  const rpc = createHeliusConnection(heliusOptions(), async (input, init) => {
    const key = new URL(String(input)).searchParams.get("api-key");
    calls.push(`${key}:${JSON.parse(String(init?.body)).method}`);
    return key === "primary-test" ? new Response("max usage reached", { status: 429 }) : balanceResponse(init);
  });
  await assert.rejects(rpc.connection.sendRawTransaction(Buffer.from([1])), /429/);
  assert.deepEqual(calls, ["primary-test:sendTransaction"]);
  assert.equal(await rpc.connection.getBalance(wallet), 123);
  assert.deepEqual(calls, ["primary-test:sendTransaction", "backup-test:getBalance"]);
});

test("a late exhausted response cannot switch back to the old key", async (t) => {
  t.mock.method(console, "warn", () => {});
  const slots: number[] = [];
  let primaryCalls = 0, complete!: (response: Response) => void;
  const rpc = createHeliusConnection(heliusOptions({ onActiveSlotChange: (slot: number) => slots.push(slot) }), async (input, init) => {
    if (new URL(String(input)).searchParams.get("api-key") === "backup-test") return balanceResponse(init);
    primaryCalls++;
    if (primaryCalls === 2) return new Promise<Response>((resolve) => { complete = resolve; });
    return new Response("max usage reached", { status: 429 });
  });
  const first = rpc.connection.getBalance(wallet), late = rpc.connection.getBalance(wallet);
  await first;
  complete(new Response("max usage reached", { status: 429 }));
  assert.equal(await late, 123);
  assert.deepEqual(slots, [2]);
});

test("LIVE confirmation migrates with unchanged strategy and cancels the old wait", async (t) => {
  t.mock.method(console, "warn", () => {});
  const strategy = { signature: "test-signature", blockhash: "test-blockhash", lastValidBlockHeight: 123 };
  const waits: any[] = [];
  let cleaned = 0;
  t.mock.method(Connection.prototype, "confirmTransaction", function (this: Connection, value: any, commitment: string) {
    waits.push({ key: new URL(this.rpcEndpoint).searchParams.get("api-key"), value, commitment, ws: (this as any)._rpcWsEndpoint });
    if (waits.length === 2) return Promise.resolve({ context: { slot: 1 }, value: { err: null } });
    return new Promise((_resolve, reject) => value.abortSignal.addEventListener("abort", () => { cleaned++; reject(value.abortSignal.reason); }, { once: true }));
  });
  const rpc = createHeliusConnection(heliusOptions(), async (input, init) =>
    new URL(String(input)).searchParams.get("api-key") === "primary-test"
      ? new Response("max usage reached", { status: 429 }) : balanceResponse(init));
  const confirmation = rpc.connection.confirmTransaction(strategy, "confirmed");
  await rpc.connection.getBalance(wallet);
  assert.equal((await confirmation).value.err, null);
  assert.equal(cleaned, 1);
  assert.deepEqual(waits.map((wait) => wait.key), ["primary-test", "backup-test"]);
  for (const wait of waits) {
    const { abortSignal, ...original } = wait.value;
    assert.deepEqual(original, strategy);
    assert.equal(wait.commitment, "confirmed");
    assert.equal(new URL(wait.ws).searchParams.get("api-key"), wait.key);
  }
});

test("caller cancellation is never mistaken for key rotation", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(Connection.prototype, "confirmTransaction", async (_strategy: any) => {
    calls++;
    throw _strategy.abortSignal.reason;
  });
  const rpc = createHeliusConnection(heliusOptions());
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(rpc.connection.confirmTransaction({ signature: "test", blockhash: "test", lastValidBlockHeight: 123, abortSignal: controller.signal }), /cancelled by caller/);
  assert.equal(calls, 1);
});

test("oversized quota errors are bounded and do not rotate", async (t) => {
  t.mock.method(console, "warn", () => {});
  const rpc = createHeliusConnection(heliusOptions({ onActiveSlotChange: () => assert.fail("Oversized response must not rotate") }), async () =>
    new Response("max usage reached" + "x".repeat(9000), { status: 429 }));
  await assert.rejects(rpc.connection.getBalance(wallet), /429/);
});

test("SQLite restores the last working slot without persisting credentials", async (t) => {
  t.mock.method(console, "warn", () => {});
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const key = new URL(String(input)).searchParams.get("api-key")!; calls.push(key);
    return key === "primary-test" ? new Response("max usage reached", { status: 429 }) : balanceResponse(init);
  };
  const options = heliusOptions({ onActiveSlotChange: (slot: number) => setMeta(db, "helius_rpc_active_slot", String(slot)) });
  await createHeliusConnection(options, fetchImpl).connection.getBalance(wallet);
  assert.equal(getMeta(db, "helius_rpc_active_slot"), "2");
  const restarted = createHeliusConnection({ ...options, activeSlot: Number(getMeta(db, "helius_rpc_active_slot")) }, fetchImpl);
  await restarted.connection.getBalance(wallet);
  assert.deepEqual(calls, ["primary-test", "backup-test", "backup-test"]);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM meta").all()), /primary-test|backup-test/);
});

test("the real SDK removes the old signature subscription when a confirmation migrates", async (t) => {
  t.mock.method(console, "warn", () => {});
  const subscribed: string[] = [], removed: number[] = [];
  const original = Connection.prototype.confirmTransaction;
  t.mock.method(Connection.prototype, "confirmTransaction", function (this: Connection, strategy: any, commitment: any) {
    t.mock.method(this, "getBlockHeight", async () => 1);
    t.mock.method(this, "getSignatureStatus", async () => ({ context: { slot: 1 }, value: null }));
    t.mock.method(this as any, "_onSubscriptionStateChange", (_id: number, changed: (state: string) => void) => {
      changed("subscribed"); return () => {};
    });
    return original.call(this, strategy, commitment);
  });
  t.mock.method(Connection.prototype, "onSignature", function (this: Connection, _signature: string, callback: any) {
    const key = new URL(this.rpcEndpoint).searchParams.get("api-key")!;
    subscribed.push(key);
    if (key === "backup-test") queueMicrotask(() => callback({ err: null }, { slot: 2 }));
    return subscribed.length;
  });
  t.mock.method(Connection.prototype, "removeSignatureListener", async (id: number) => { removed.push(id); });
  const rpc = createHeliusConnection(heliusOptions(), async (input, init) =>
    new URL(String(input)).searchParams.get("api-key") === "primary-test"
      ? new Response("max usage reached", { status: 429 }) : balanceResponse(init));
  const confirmation = rpc.connection.confirmTransaction({ signature: "1".repeat(64), blockhash: "test", lastValidBlockHeight: 100 }, "confirmed");
  await rpc.connection.getBalance(wallet);
  assert.equal((await confirmation).context.slot, 2);
  assert.deepEqual(subscribed, ["primary-test", "backup-test"]);
  assert.ok(removed.includes(1));
});

test("429 cooldown is shared, doubles to five minutes, and admits only one recovery probe", async (t) => {
  let now = Date.parse("2026-11-02T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  let recover: ((response: Response) => void) | undefined;
  const rpc = createRpcFetch(async () => {
    calls++;
    return calls <= 5 ? new Response("exhausted", { status: 429 }) : new Promise<Response>((resolve) => { recover = resolve; });
  });
  for (const wait of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    assert.equal((await rpc.fetch(url, request())).status, 429);
    await assert.rejects(rpc.fetch(url, request("getProgramAccounts")), /cooling down/);
    now += wait - 1;
    await assert.rejects(rpc.fetch(url, request()), /cooling down/);
    now++;
  }
  assert.equal(calls, 5);
  const probe = rpc.fetch(url, request());
  await assert.rejects(rpc.fetch(url, request()), /cooling down/);
  assert.equal(calls, 6);
  recover!(new Response("{}"));
  await probe;
  const next = rpc.fetch(url, request());
  assert.equal(calls, 7);
  recover!(new Response("{}"));
  await next;
});

test("Retry-After supports seconds and HTTP dates; failed probes retain the cooldown", async (t) => {
  let now = Date.parse("2026-11-02T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  for (const header of ["600", new Date(now + 600_000).toUTCString()]) {
    const start = now;
    let calls = 0;
    const rpc = createRpcFetch(async () => {
      calls++;
      if (calls === 1) return new Response("quota", { status: 429, headers: { "retry-after": header } });
      if (calls === 2) throw new Error("network unavailable");
      return new Response("unavailable", { status: 503 });
    });
    await rpc.fetch(url, request());
    now = start + 599_999;
    await assert.rejects(rpc.fetch(url, request()), /cooling down/);
    now++;
    await assert.rejects(rpc.fetch(url, request()), /network unavailable/);
    await assert.rejects(rpc.fetch(url, request()), /cooling down/);
    now += 60_000;
    assert.equal((await rpc.fetch(url, request())).status, 503);
    await assert.rejects(rpc.fetch(url, request()), /cooling down/);
    assert.equal(calls, 3);
    // Keep the next HTTP-date case relative to its original header.
    now = Date.parse("2026-11-02T00:00:00Z");
  }
});

test("usage counts actual methods including JSON-RPC batches and omits request secrets", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...values) => logs.push(values.join(" ")));
  const rpc = createRpcFetch(async () => new Response("{}"));
  await rpc.fetch(url, request("getProgramAccounts"));
  await rpc.fetch(url, { body: JSON.stringify([{ method: "getBalance" }, { method: "getMultipleAccounts" }]) });
  rpc.report();
  const report = JSON.parse(logs[0].slice("Helius RPC usage: ".length));
  assert.deepEqual(report.methods, { getProgramAccounts: 1, getBalance: 1, getMultipleAccounts: 1 });
  assert.equal(report.estimatedCredits, 12);
  assert.equal(report.rateLimited, 0);
  assert.doesNotMatch(logs[0], /never-log-this|private-wallet|https:/);
  rpc.report();
  assert.deepEqual(JSON.parse(logs[1].slice("Helius RPC usage: ".length)).methods, {});
});

test("Connection disables built-in 429 retries and SDK requests share the guard", async (t) => {
  let calls = 0;
  const rpc = createRpcFetch(async () => { calls++; return new Response("max usage reached", { status: 429 }); });
  const connection = new Connection(url, { fetch: rpc.fetch, disableRetryOnRateLimit: true });
  t.mock.method(console, "error", () => {});
  await assert.rejects(connection.getBalance(new PublicKey(Buffer.alloc(32, 1))), /429/);
  await assert.rejects(connection.getAccountInfo(new PublicKey(Buffer.alloc(32, 2))), /cooling down/);
  assert.equal(calls, 1);
});

test("an older in-flight 429 cannot be cleared by a successful recovery probe", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const pending: Array<(response: Response) => void> = [];
  const rpc = createRpcFetch(async () => {
    calls++;
    if (calls === 1) return new Response("quota", { status: 429 });
    return new Promise<Response>((resolve) => pending.push(resolve));
  });
  const first = rpc.fetch(url, request());
  const old = rpc.fetch(url, request());
  await first;
  now += 60_000;
  const probe = rpc.fetch(url, request());
  pending[0](new Response("quota", { status: 429 }));
  await old;
  pending[1](new Response("{}"));
  await probe;
  await assert.rejects(rpc.fetch(url, request()), /cooling down/);
  assert.equal(calls, 3);
});
