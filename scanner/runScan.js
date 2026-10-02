import { getScanConfig } from "./config.js";
import { getLatestBlock, scanRange } from "./rangeScanner.js";
import { investigateTransaction } from "../analyzers/caseEngine.js";
import { saveTransaction, saveCase, getScanProgress, setScanProgress } from "../database/repository.js";
import { pool } from "../database/connection.js";

const config = getScanConfig();

if (!config.rpcUrl) {
  console.error("RPC_URL is required");
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scanOnce() {
  let fromBlock = config.fromBlock;
  let toBlock = config.toBlock;
  let historical = false;

  if (config.historicalScan && config.fromBlock === 0 && config.toBlock === 0) {
    const latestBlock = await getLatestBlock(config.rpcUrl);
    fromBlock = await getScanProgress(config.chain, config.historicalStartBlock);

    if (fromBlock <= latestBlock) {
      toBlock = Math.min(fromBlock + config.historicalBatchBlocks - 1, latestBlock);
      historical = true;
    } else {
      fromBlock = Math.max(0, latestBlock - 4);
      toBlock = latestBlock;
    }
  } else if (fromBlock === 0 && toBlock === 0) {
    toBlock = await getLatestBlock(config.rpcUrl);
    fromBlock = Math.max(0, toBlock - 4);
  }

  if (toBlock < fromBlock) throw new Error("invalid scan range");

  await setScanProgress(config.chain, fromBlock, {
    currentBlock: fromBlock,
    status: historical ? "scanning_historical" : "scanning_live",
    batchTransactions: 0,
    batchCases: 0
  });

  console.log(`[SCAN] ${historical ? "HISTORICAL" : "LIVE"} blocks=${fromBlock}-${toBlock}`);

  const transactions = await scanRange({ ...config, fromBlock, toBlock });
  let savedTransactions = 0;
  let savedCases = 0;
  let recoveryCandidates = 0;

  for (const tx of transactions) {
    await saveTransaction(tx);
    savedTransactions++;

    const caseData = investigateTransaction({
      ...tx,
      authorizedDestination: config.authorizedDestination
    });

    if (caseData.findings.length > 0) {
      await saveCase(caseData);
      savedCases++;

      if (caseData.recoveryEligible) {
        recoveryCandidates++;
        console.log(JSON.stringify({
          event: "RECOVERY_CANDIDATE",
          txHash: caseData.hash,
          chain: caseData.chain,
          recoveryStatus: caseData.recoveryStatus,
          mode: config.recoveryMode,
          destination: config.authorizedDestination || "NOT_CONFIGURED"
        }));
      }
    }
  }

  if (config.historicalScan && historical) {
    await setScanProgress(config.chain, toBlock + 1, {
      currentBlock: toBlock,
      status: "batch_complete",
      batchTransactions: savedTransactions,
      batchCases: savedCases
    });
  } else {
    await setScanProgress(config.chain, toBlock, {
      currentBlock: toBlock,
      status: "live_complete",
      batchTransactions: savedTransactions,
      batchCases: savedCases
    });
  }

  console.log(JSON.stringify({
    chain: config.chain,
    mode: historical ? "historical" : "live",
    blocks: { from: fromBlock, to: toBlock },
    transactions: transactions.length,
    savedTransactions,
    savedCases,
    recoveryCandidates,
    recoveryMode: config.recoveryMode,
    authorizedDestinationConfigured: Boolean(config.authorizedDestination),
    nextHistoricalBlock: historical ? toBlock + 1 : null
  }, null, 2));

  return toBlock;
}

try {
  do {
    await scanOnce();

    if (!config.monitor) break;

    await sleep(config.intervalSeconds * 1000);
    config.fromBlock = 0;
    config.toBlock = 0;
  } while (true);
} finally {
  await pool.end();
}
