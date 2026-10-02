import { rpcCall, sleep } from "../indexer/rpcClient.js";
import { normalizeTransaction } from "../indexer/normalizer.js";

const DEFAULT_RECEIPT_CONCURRENCY = 2;
const DEFAULT_RECEIPT_DELAY_MS = 150;
const DEFAULT_BLOCK_CONCURRENCY = 4;
const DEFAULT_BLOCK_DELAY_MS = 25;
const DEFAULT_PROGRESS_EVERY_BLOCKS = 25;
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa9527f163c4a11628a1f0b5c8b7b5d";

function topicAddress(topic) {
  if (typeof topic !== "string" || !topic.startsWith("0x") || topic.length < 66) return null;
  return "0x" + topic.slice(-40);
}

function decodeTransferLogs(logs = []) {
  return logs
    .filter(log =>
      Array.isArray(log.topics) &&
      log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
      log.topics.length >= 3
    )
    .map(log => ({
      tokenContract: log.address ?? null,
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      amountHex: log.data ?? "0x0"
    }));
}

export async function getLatestBlock(rpcUrl) {
  const result = await rpcCall(rpcUrl, "eth_blockNumber", []);
  return Number.parseInt(result, 16);
}

async function enrichWithReceipt(rpcUrl, tx) {
  const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [tx.hash]);
  if (!receipt) return tx;

  return normalizeTransaction({
    ...tx,
    status: receipt.status === "0x0" ? "failed" : "success",
    gasUsed: receipt.gasUsed ?? null,
    logs: receipt.logs ?? [],
    tokenTransfers: decodeTransferLogs(receipt.logs)
  }, tx.chain);
}

async function enrichReceipts(
  rpcUrl,
  transactions,
  concurrency = DEFAULT_RECEIPT_CONCURRENCY,
  delayMs = DEFAULT_RECEIPT_DELAY_MS
) {
  const results = new Array(transactions.length);
  let nextIndex = 0;
  let failedReceipts = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= transactions.length) return;
      const tx = transactions[index];

      try {
        results[index] = await enrichWithReceipt(rpcUrl, tx);
      } catch (error) {
        failedReceipts++;
        console.warn(`[RECEIPT] failed for ${tx.hash}: ${error.message}`);
        results[index] = tx;
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), transactions.length);
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  const tokenTransferCount = results.reduce(
    (count, tx) => count + (tx.tokenTransfers?.length ?? 0), 0
  );

  console.log(
    `[RECEIPT] processed=${transactions.length} failed=${failedReceipts} tokenTransfers=${tokenTransferCount}`
  );

  return results;
}

export async function scanRange({
  rpcUrl,
  chain = "evm",
  fromBlock,
  toBlock,
  receiptConcurrency = DEFAULT_RECEIPT_CONCURRENCY,
  receiptDelayMs = DEFAULT_RECEIPT_DELAY_MS,
  blockConcurrency = DEFAULT_BLOCK_CONCURRENCY,
  blockDelayMs = DEFAULT_BLOCK_DELAY_MS,
  progressEveryBlocks = DEFAULT_PROGRESS_EVERY_BLOCKS,
  onProgress = null
}) {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || fromBlock > toBlock) {
    throw new Error("invalid block range");
  }

  const totalBlocks = toBlock - fromBlock + 1;
  const observations = [];
  const concurrency = Math.min(Math.max(1, blockConcurrency), totalBlocks);
  const every = Math.max(1, progressEveryBlocks);
  let nextBlock = fromBlock;
  let completedBlocks = 0;
  let discoveredTransactions = 0;
  let highestCompletedBlock = fromBlock - 1;
  let lastReported = 0;
  let progressChain = Promise.resolve();

  const reportProgress = (force = false) => {
    if (!onProgress) return;
    if (!force && completedBlocks - lastReported < every) return;
    lastReported = completedBlocks;

    const payload = {
      fromBlock,
      toBlock,
      currentBlock: highestCompletedBlock,
      scannedBlocks: completedBlocks,
      totalBlocks,
      transactions: discoveredTransactions
    };

    progressChain = progressChain
      .then(() => onProgress(payload))
      .catch(error => console.warn(`[SCAN] progress update failed: ${error.message}`));
  };

  async function worker() {
    while (true) {
      const blockNumber = nextBlock++;
      if (blockNumber > toBlock) return;

      const hexBlock = "0x" + blockNumber.toString(16);
      const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", [hexBlock, true]);

      if (block) {
        const blockTransactions = block.transactions ?? [];
        for (const tx of blockTransactions) {
          observations.push(normalizeTransaction({
            ...tx,
            blockNumber,
            timestamp: block.timestamp ? Number.parseInt(block.timestamp, 16) : null
          }, chain));
        }
        discoveredTransactions += blockTransactions.length;
      }

      completedBlocks++;
      if (blockNumber > highestCompletedBlock) highestCompletedBlock = blockNumber;
      reportProgress();

      if (blockDelayMs > 0) await sleep(blockDelayMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  reportProgress(true);
  await progressChain;

  console.log(
    `[BLOCKS] scanned=${completedBlocks}/${totalBlocks} tx=${discoveredTransactions} concurrency=${concurrency}`
  );

  return enrichReceipts(rpcUrl, observations, receiptConcurrency, receiptDelayMs);
}
