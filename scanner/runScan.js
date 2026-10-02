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

let fromBlock = config.fromBlock;
let toBlock = config.toBlock;

if (fromBlock === 0 && toBlock === 0) {
  toBlock = await getLatestBlock(config.rpcUrl);
  fromBlock = Math.max(0, toBlock - 4);
}

if (toBlock < fromBlock) throw new Error("invalid scan range");

try {
  const transactions = await scanRange({ ...config, fromBlock, toBlock });
  let savedTransactions = 0;
  let savedCases = 0;

  for (const tx of transactions) {
    await saveTransaction(tx);
    savedTransactions++;

    const caseData = investigateTransaction(tx);
    if (caseData.findings.length > 0) {
      await saveCase(caseData);
      savedCases++;
    }
  }

  console.log(JSON.stringify({
    chain: config.chain,
    blocks: { from: fromBlock, to: toBlock },
    transactions: transactions.length,
    savedTransactions,
    savedCases
  }, null, 2));
} finally {
  await pool.end();
}
