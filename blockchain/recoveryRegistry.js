import { ethers } from "ethers";

export const RECOVERY_REGISTRY_ABI = [
  "function createRequest(address owner,uint256 caseId,uint256 chainId,uint256 amountWei,address destination,uint64 expiresAt) returns (uint256 requestId)",
  "function requests(uint256 requestId) view returns (address owner,uint256 caseId,uint256 chainId,uint256 amountWei,address destination,uint64 expiresAt,uint8 status)",
  "function approve(uint256 requestId)",
  "function reject(uint256 requestId)",
  "event RecoveryRequestCreated(uint256 indexed requestId,address indexed owner,uint256 indexed caseId,uint256 chainId,uint256 amountWei,address destination,uint64 expiresAt)",
  "event RecoveryRequestApproved(uint256 indexed requestId,address indexed owner)",
  "event RecoveryRequestRejected(uint256 indexed requestId,address indexed owner)",
  "event RecoveryRequestExpired(uint256 indexed requestId)"
];

export function getRecoveryRegistry() {
  const rpcUrl = process.env.RECOVERY_REGISTRY_RPC_URL || process.env.RPC_URL;
  const registryAddress = process.env.RECOVERY_REGISTRY_ADDRESS;
  const operatorKey = process.env.RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY;

  if (!rpcUrl || !registryAddress || !operatorKey) return null;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(operatorKey, provider);
  return new ethers.Contract(registryAddress, RECOVERY_REGISTRY_ABI, wallet);
}

export function isRecoveryRegistryConfigured() {
  return Boolean(
    (process.env.RECOVERY_REGISTRY_RPC_URL || process.env.RPC_URL) &&
    process.env.RECOVERY_REGISTRY_ADDRESS &&
    process.env.RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY
  );
}

export async function createOnChainRecoveryRequest({
  owner, caseId, chainId, amountWei, destination, expiresAt
}) {
  const registry = getRecoveryRegistry();
  if (!registry) throw new Error("recovery_registry_not_configured");

  const tx = await registry.createRequest(
    owner,
    BigInt(caseId),
    BigInt(chainId),
    BigInt(amountWei || 0),
    destination,
    Math.floor(new Date(expiresAt).getTime() / 1000)
  );
  const receipt = await tx.wait();

  const iface = new ethers.Interface(RECOVERY_REGISTRY_ABI);
  let requestId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "RecoveryRequestCreated") {
        requestId = parsed.args.requestId.toString();
        break;
      }
    } catch {}
  }

  if (!requestId) throw new Error("recovery_request_id_not_found");
  return { requestId, txHash: receipt.hash };
}

export function getRecoveryRegistryReadContract() {
  const rpcUrl = process.env.RECOVERY_REGISTRY_RPC_URL || process.env.RPC_URL;
  const registryAddress = process.env.RECOVERY_REGISTRY_ADDRESS;
  if (!rpcUrl || !registryAddress) return null;
  return new ethers.Contract(
    registryAddress,
    RECOVERY_REGISTRY_ABI,
    new ethers.JsonRpcProvider(rpcUrl)
  );
}
