import { getScanConfig } from "./config.js";
import { scanRange } from "./rangeScanner.js";
import { investigateTransaction } from "../analyzers/caseEngine.js";

const config = getScanConfig();

if (!config.rpcUrl) {
  console.error("RPC_URL is required");
  process.exit(1);
}

if (!Number.isInteger(config.fromBlock) || !Number.isInteger(config.toBlock) || config.toBlock < config.fromBlock) {
  console.error("FROM_BLOCK and TO_BLOCK must define a valid range");
  process.exit(1);
}

const transactions = await scanRange(config);
const cases = transactions
  .map(investigateTransaction)
  .filter(item => item.findings.length > 0);

console.log(JSON.stringify({
  chain: config.chain,
  blocks: { from: config.fromBlock, to: config.toBlock },
  transactions: transactions.length,
  cases: cases.length,
  findings: cases
}, null, 2));
