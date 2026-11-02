import assert from "node:assert/strict";
import test from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { createRpcFetch } from "../src/market-data/rpc.ts";

const url = "https://mainnet.helius-rpc.com/?api-key=never-log-this";
const request = (method = "getBalance") => ({ body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params: ["private-wallet"] }) });

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
