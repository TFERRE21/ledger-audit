import { getScanConfig } from "./config.js";
import { getLatestBlock, scanRange } from "./rangeScanner.js";
import { investigateTransaction } from "../analyzers/caseEngine.js";
import { saveTransaction, saveCase, getScanProgress, setScanProgress, saveScanLog, saveContractFinding } from "../database/repository.js";
import { pool } from "../database/connection.js";
import { scanContracts } from "./contractScanner.js";

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

  const scanStartedAt = Date.now();
  console.log(
    `[SCAN] ${historical ? "HISTORICAL" : "LIVE"} blocks=${fromBlock}-${toBlock} ` +
    `blockConcurrency=${config.blockConcurrency}`
  );

  const transactions = await scanRange({
    ...config,
    fromBlock,
    toBlock,
    onProgress: async progress => {
      const elapsedSeconds = Math.max(0.001, (Date.now() - scanStartedAt) / 1000);
      const speed = progress.scannedBlocks / elapsedSeconds;
      const remainingBlocks = Math.max(0, progress.totalBlocks - progress.scannedBlocks);
      const etaSeconds = speed > 0 ? remainingBlocks / speed : null;
      const logLine = `[SCAN] progress block=${progress.currentBlock} blocks=${progress.scannedBlocks}/${progress.totalBlocks} tx=${progress.transactions}`;

      await setScanProgress(config.chain, progress.currentBlock + 1, {
        currentBlock: progress.currentBlock,
        status: historical ? "scanning_historical" : "scanning_live",
        batchTransactions: progress.transactions,
        batchCases: 0,
        speedBlocksPerSecond: speed,
        etaSeconds,
        logLine
      });

      console.log(logLine);
      await saveScanLog({ chain: config.chain, blockNumber: progress.currentBlock, message: logLine });
    }
  });

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
        const opportunityLog = `[OPPORTUNITY] tx=${caseData.hash} confidence=${caseData.confidence} recovery=${caseData.recoveryStatus}`;
        await saveScanLog({ chain: config.chain, blockNumber: tx.blockNumber, level: "opportunity", message: opportunityLog, opportunity: true });
        console.log(opportunityLog);
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

  const contractFindings = await scanContracts(config.rpcUrl, transactions, config.contractScanLimit);
  let contractOpportunities = 0;
  for (const finding of contractFindings) {
    const normalized = { ...finding, chain: config.chain, blockNumber: toBlock };
    await saveContractFinding(normalized);
    if (finding.potential) {
      contractOpportunities++;
      const message = `[CONTRACT_OPPORTUNITY] address=${finding.address} ethBalanceWei=${finding.ethBalanceWei} owner=${finding.owner || "none"} admin=${finding.admin || "none"} signals=${[...(finding.signals||[]), ...(finding.methodSignals||[])].join(",") || "none"}`;
      await saveScanLog({ chain: config.chain, blockNumber: toBlock, level: "contract_opportunity", message, opportunity: true });
      console.log(message);
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
    contractFindings: contractFindings.length,
    contractOpportunities,
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
