import { getScanConfig } from "./config.js";
import { getLatestBlock, scanRange } from "./rangeScanner.js";
import { investigateTransaction } from "../analyzers/caseEngine.js";

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

if (toBlock < fromBlock) {
  throw new Error("invalid scan range");
}

const transactions = await scanRange({
  ...config,
  fromBlock,
  toBlock
});

const cases = transactions
  .map(investigateTransaction)
  .filter(item => item.findings.length > 0);

console.log(JSON.stringify({
  chain: config.chain,
  blocks: { from: fromBlock, to: toBlock },
  transactions: transactions.length,
  cases: cases.length,
  findings: cases
}, null, 2));
