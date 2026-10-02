export function getScanConfig(env = process.env) {
  return {
    rpcUrl: env.RPC_URL,
    chain: env.CHAIN || "ethereum",
    fromBlock: Number(env.FROM_BLOCK || 0),
    toBlock: Number(env.TO_BLOCK || 0)
  };
}
