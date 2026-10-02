import { rpcCall } from "../indexer/rpcClient.js";
import { normalizeTransaction } from "../indexer/normalizer.js";

export async function getLatestBlock(rpcUrl) {
  const result = await rpcCall(rpcUrl, "eth_blockNumber");
  return Number.parseInt(result, 16);
}

export async function scanRange({ rpcUrl, chain = "evm", fromBlock, toBlock }) {
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
  return observations;
}
