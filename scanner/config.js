export function getScanConfig(env = process.env) {
  return {
    rpcUrl: env.RPC_URL,
    chain: env.CHAIN || "ethereum",
    fromBlock: Number(env.FROM_BLOCK || 0),
    toBlock: Number(env.TO_BLOCK || 0),
    monitor: String(env.MONITOR || "false").toLowerCase() === "true",
    intervalSeconds: Math.max(15, Number(env.SCAN_INTERVAL_SECONDS || 60)),
    recoveryMode: String(env.RECOVERY_MODE || "DRY_RUN").toUpperCase(),
    authorizedDestination: env.AUTHORIZED_DESTINATION_ADDRESS || null,
    historicalScan: String(env.HISTORICAL_SCAN || "false").toLowerCase() === "true",
    historicalStartBlock: Math.max(0, Number(env.HISTORICAL_START_BLOCK || 0)),
    historicalBatchBlocks: Math.max(1, Number(env.HISTORICAL_BATCH_BLOCKS || 1000)),
    blockConcurrency: Math.min(6, Math.max(1, Number(env.BLOCK_CONCURRENCY || 4))),
    blockDelayMs: Math.max(0, Number(env.BLOCK_DELAY_MS || 25)),
    progressEveryBlocks: Math.max(5, Number(env.PROGRESS_EVERY_BLOCKS || 25))
  };
}
