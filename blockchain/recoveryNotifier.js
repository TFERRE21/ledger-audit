import { ethers } from "ethers";

const RECOVERY_REGISTRY_ABI = [
  "event RecoveryRequestCreated(uint256 indexed requestId,address indexed owner,uint256 indexed caseId,uint256 chainId,uint256 amountWei,address destination,uint64 expiresAt)"
];

export function startRecoveryChainNotifier({ onRequestCreated }) {
  const rpcUrl = process.env.RECOVERY_REGISTRY_RPC_URL || process.env.RPC_URL;
  const registryAddress = process.env.RECOVERY_REGISTRY_ADDRESS;

  if (!rpcUrl || !registryAddress || !ethers.isAddress(registryAddress)) {
    console.warn("[RECOVERY_NOTIFIER] disabled: RPC/registry not configured");
    return null;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(registryAddress, RECOVERY_REGISTRY_ABI, provider);

  const listener = async (requestId, owner, caseId, chainId, amountWei, destination, expiresAt, event) => {
    try {
      await onRequestCreated({
        requestId: requestId.toString(),
        owner: owner.toLowerCase(),
        caseId: caseId.toString(),
        chainId: chainId.toString(),
        amountWei: amountWei.toString(),
        destination: destination.toLowerCase(),
        expiresAt: new Date(Number(expiresAt) * 1000).toISOString(),
        txHash: event?.log?.transactionHash || event?.transactionHash || null,
        blockNumber: event?.log?.blockNumber ?? event?.blockNumber ?? null
      });
    } catch (error) {
      console.error("[RECOVERY_NOTIFIER] event handling failed:", error.message);
    }
  };

  contract.on("RecoveryRequestCreated", listener);
  console.log("[RECOVERY_NOTIFIER] listening to RecoveryRequestCreated on", registryAddress);

  return {
    provider,
    contract,
    stop: async () => {
      try {
        await contract.off("RecoveryRequestCreated", listener);
        await provider.destroy();
      } catch {}
    }
  };
}
