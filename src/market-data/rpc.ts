// Shared by every SDK caller through Connection's public fetch option.
export function createRpcFetch(fetchImpl: typeof fetch = fetch) {
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
        console.warn("Helius RPC HTTP 429; next attempt at", new Date(retryAt).toISOString());
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
    console.log("Helius RPC usage:", JSON.stringify({ since, until, methods: Object.fromEntries(methods), estimatedCredits, rateLimited, deferred }));
    methods.clear(); deferred = 0; rateLimited = 0; since = until;
  }

  return { fetch: rpcFetch, report };
}
