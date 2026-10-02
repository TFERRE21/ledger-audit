export function getScanConfig(env = process.env) {
  return {
    rpcUrl: env.RPC_URL,
    chain: env.CHAIN || "ethereum",
    fromBlock: Number(env.FROM_BLOCK || 0),
    toBlock: Number(env.TO_BLOCK || 0),
    monitor: String(env.MONITOR || "false").toLowerCase() === "true",
    intervalSeconds: Math.max(15, Number(env.SCAN_INTERVAL_SECONDS || 60)),
    recoveryMode: String(env.RECOVERY_MODE || "DRY_RUN").toUpperCase(),
    authorizedDestination: env.AUTHORIZED_DESTINATION_ADDRESS || null
  };
}
