import { rpcCall } from "../indexer/rpcClient.js";
import { normalizeTransaction } from "../indexer/normalizer.js";

const DEFAULT_RECEIPT_CONCURRENCY = 8;

export async function getLatestBlock(rpcUrl) {
  const result = await rpcCall(rpcUrl, "eth_blockNumber");
  return Number.parseInt(result, 16);
}

async function enrichWithReceipt(rpcUrl, tx) {
  const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [tx.hash]);

  if (!receipt) {
    return tx;
  }

  return normalizeTransaction({
    ...tx,
    status: receipt.status === "0x0" ? "failed" : "success",
    gasUsed: receipt.gasUsed ?? null
  }, tx.chain);
}

async function enrichReceipts(rpcUrl, transactions, concurrency = DEFAULT_RECEIPT_CONCURRENCY) {
  const results = new Array(transactions.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= transactions.length) return;

      const tx = transactions[index];
      try {
        results[index] = await enrichWithReceipt(rpcUrl, tx);
      } catch (error) {
        console.warn(`[RECEIPT] ${tx.hash}: ${error.message}`);
        results[index] = tx;
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), transactions.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function scanRange({
  rpcUrl,
  chain = "evm",
  fromBlock,
  toBlock,
  receiptConcurrency = DEFAULT_RECEIPT_CONCURRENCY
}) {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || fromBlock > toBlock) {
    throw new Error("invalid block range");
  }

  const observations = [];
  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
    const hexBlock = "0x" + blockNumber.toString(16);
    const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", [hexBlock, true]);
    if (!block) continue;

    for (const tx of block.transactions ?? []) {
      observations.push(normalizeTransaction({
        ...tx,
        blockNumber,
        timestamp: block.timestamp ? Number.parseInt(block.timestamp, 16) : null
      }, chain));
    }
  }

  return enrichReceipts(rpcUrl, observations, receiptConcurrency);
}
