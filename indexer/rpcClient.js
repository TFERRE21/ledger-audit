const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 750;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function rpcCall(
  rpcUrl,
  method,
  params = [],
  { maxRetries = DEFAULT_MAX_RETRIES, backoffMs = DEFAULT_BACKOFF_MS } = {}
) {
  if (!rpcUrl) throw new Error("RPC_URL is required");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
    });

    if (response.ok) {
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message || "RPC error");
      return payload.result;
    }

    if (response.status !== 429 || attempt === maxRetries) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const delay = backoffMs * 2 ** attempt;
    await sleep(delay);
  }
}

export { sleep };
