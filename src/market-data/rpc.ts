import { Connection, type Commitment, type TransactionConfirmationStrategy } from "@solana/web3.js";

// Shared by every SDK caller through Connection's public fetch option.
export function createRpcFetch(fetchImpl: typeof fetch = fetch, slot = 1) {
  let retryAt = 0;
  let backoffMs = 0;
  let probing = false;
  let generation = 0;
  let since = Date.now();
  let deferred = 0;
  let rateLimited = 0;
  const methods = new Map<string, number>();

  const rpcFetch: typeof fetch = async (input, init) => {
    if (Date.now() < retryAt || (backoffMs > 0 && probing)) {
      deferred++;
      throw new Error("Helius RPC cooling down after HTTP 429");
    }
    const probe = backoffMs > 0;
    const startedGeneration = generation;
    if (probe) probing = true;
    try {
      let requests: unknown = [];
      try { requests = JSON.parse(typeof init?.body === "string" ? init.body : "[]"); } catch { /* Count malformed requests without logging their content. */ }
      for (const request of Array.isArray(requests) ? requests : [requests]) {
        const method = typeof request?.method === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(request.method) ? request.method : "unknown";
        methods.set(method, (methods.get(method) ?? 0) + 1);
      }
      const response = await fetchImpl(input, init);
      if (response.status === 429) {
        generation++;
        rateLimited++;
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : 60_000, 300_000);
        const header = response.headers.get("retry-after");
        const deadline = header && /^\d+(?:\.\d+)?$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header ?? "");
        retryAt = Math.max(retryAt, Date.now() + backoffMs, Number.isFinite(deadline) ? deadline : 0);
        console.warn(`Helius RPC slot ${slot} HTTP 429; next attempt at`, new Date(retryAt).toISOString());
      } else if (probe && generation === startedGeneration) {
        if (response.ok) { retryAt = 0; backoffMs = 0; }
        else retryAt = Date.now() + backoffMs;
      }
      return response;
    } catch (error) {
      if (probe) retryAt = Math.max(retryAt, Date.now() + backoffMs);
      throw error;
    } finally {
      if (probe) probing = false;
    }
  };

  function report(): void {
    const until = Date.now();
    // shortcut: estimates cover this process's RPC attempts; Helius billing remains authoritative.
    const estimatedCredits = [...methods].reduce((sum, [method, count]) => sum + count * (method === "getProgramAccounts" ? 10 : 1), 0);
    console.log("Helius RPC usage:", JSON.stringify({ slot, since, until, methods: Object.fromEntries(methods), estimatedCredits, rateLimited, deferred }));
    methods.clear(); deferred = 0; rateLimited = 0; since = until;
  }

  return { fetch: rpcFetch, report, available: () => Date.now() >= retryAt && !(backoffMs > 0 && probing) };
}

async function quotaExhausted(response: Response): Promise<boolean> {
  if (response.status !== 429) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) return false;
      chunks.push(value);
    }
    return /max usage reached|monthly (?:credit|usage) limit (?:reached|exceeded)|credits? exhausted/i.test(Buffer.concat(chunks).toString("utf8"));
  } catch { return false; }
  finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

type HeliusOptions = {
  httpBase: string;
  wsBase: string;
  primaryKey: string;
  backupKey?: string;
  activeSlot?: number;
  onActiveSlotChange: (slot: number) => void;
};

export function createHeliusConnection(options: HeliusOptions, fetchImpl: typeof fetch = fetch) {
  const primary = options.primaryKey.trim(), backup = options.backupKey?.trim();
  if (!primary) throw new Error("Missing HELIUS_API_KEY");
  const keys = [primary, ...(backup && backup !== primary ? [backup] : [])];
  let active = options.activeSlot === 2 && keys.length === 2 ? 1 : 0;
  let rotation = new AbortController();
  const exhausted = keys.map(() => false);
  const guards = keys.map((_, index) => createRpcFetch(fetchImpl, index + 1));

  function endpoint(base: string, key: string, protocol: string): string {
    const url = new URL(base);
    if (url.protocol !== protocol || url.hostname !== "mainnet.helius-rpc.com" || url.username || url.password) {
      throw new Error("Invalid trusted Helius endpoint");
    }
    url.searchParams.set("api-key", key);
    return url.toString();
  }

  function switchTo(index: number): void {
    if (index === active) return;
    options.onActiveSlotChange(index + 1);
    const previous = rotation;
    active = index;
    rotation = new AbortController();
    previous.abort(new Error("Helius RPC key switched"));
    console.warn(`Helius RPC switched to slot ${index + 1} after quota exhaustion`);
  }

  const routeFetch: typeof fetch = async (_input, init) => {
    const visited = new Set<number>();
    let canRetry = false;
    try {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null");
      const requests = Array.isArray(body) ? body : [body];
      canRetry = requests.length > 0 && requests.every((request) =>
        typeof request?.method === "string" && (/^get[A-Z]/.test(request.method) || request.method === "simulateTransaction" || request.method === "isBlockhashValid"));
    } catch { /* Unknown requests are never replayed. */ }
    if (exhausted[active] && !guards[active].available()) {
      const ready = guards.findIndex((guard, index) => index !== active && guard.available());
      if (ready >= 0) switchTo(ready);
    }
    while (true) {
      const index = active;
      visited.add(index);
      const response = await guards[index].fetch(endpoint(options.httpBase, keys[index], "https:"), init);
      if (!await quotaExhausted(response)) {
        if (response.ok) exhausted[index] = false;
        return response;
      }
      exhausted[index] = true;
      // A late response from an old key must not reverse a newer switch.
      const next = active !== index ? active : guards.findIndex((guard, candidate) => candidate !== index && guard.available());
      if (next < 0 || visited.has(next) || !guards[next].available()) return response;
      switchTo(next);
      if (!canRetry) return response;
      await response.body?.cancel();
    }
  };

  const clients = keys.map((key) => new Connection(endpoint(options.httpBase, key, "https:"), {
    wsEndpoint: endpoint(options.wsBase, key, "wss:"), commitment: "confirmed",
    fetch: routeFetch, disableRetryOnRateLimit: true,
  }));

  async function confirmTransaction(strategy: TransactionConfirmationStrategy | string, commitment?: Commitment) {
    // shortcut: legacy signature-only confirmations cannot migrate; Yolow always supplies blockhash strategies.
    if (typeof strategy === "string") return clients[active].confirmTransaction(strategy, commitment);
    const visited = new Set<number>();
    while (true) {
      const index = active, change = rotation.signal;
      visited.add(index);
      const abortSignal = strategy.abortSignal ? AbortSignal.any([strategy.abortSignal, change]) : change;
      try {
        return await clients[index].confirmTransaction({ ...strategy, abortSignal }, commitment);
      } catch (error) {
        if (!change.aborted || strategy.abortSignal?.aborted || visited.has(active)) throw error;
      }
    }
  }

  const connection = new Proxy(clients[active], {
    get(_target, property) {
      if (property === "confirmTransaction") return confirmTransaction;
      const client = clients[active];
      const value = Reflect.get(client, property, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
  return { connection, report: () => guards.forEach((guard) => guard.report()) };
}
