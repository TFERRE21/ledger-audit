import { getScanConfig } from "./config.js";
import { getLatestBlock, scanRange } from "./rangeScanner.js";
import { investigateTransaction } from "../analyzers/caseEngine.js";
import { saveTransaction, saveCase } from "../database/repository.js";
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

  if (fromBlock === 0 && toBlock === 0) {
    toBlock = await getLatestBlock(config.rpcUrl);
    fromBlock = Math.max(0, toBlock - 4);
  }

  if (toBlock < fromBlock) throw new Error("invalid scan range");

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

  console.log(JSON.stringify({
    chain: config.chain,
    blocks: { from: fromBlock, to: toBlock },
    transactions: transactions.length,
    savedTransactions,
    savedCases,
    recoveryCandidates,
    recoveryMode: config.recoveryMode,
    authorizedDestinationConfigured: Boolean(config.authorizedDestination)
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
