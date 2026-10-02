export function normalizeTransaction(raw, chain) {
  if (!raw) throw new Error("transaction is required");

  return {
    chain,
    hash: raw.hash ?? null,
    blockNumber: raw.blockNumber ?? null,
    from: raw.from ?? null,
    to: raw.to ?? null,
    value: raw.value ?? "0",
    status: raw.status ?? null,
    gasUsed: raw.gasUsed ?? null,
    timestamp: raw.timestamp ?? null,
    input: raw.input ?? "0x",
    logs: Array.isArray(raw.logs) ? raw.logs : [],
    tokenTransfers: Array.isArray(raw.tokenTransfers) ? raw.tokenTransfers : []
  };
}
