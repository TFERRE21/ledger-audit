import { ethers } from "ethers";

export const RECOVERY_NOTIFICATION_REGISTRY_ABI = [
  "function createNotification(address owner,uint256 requestId,uint256 caseId,uint256 chainId,uint256 amountWei,address destination,uint64 expiresAt,string message) returns (uint256 notificationId)",
  "function notifications(uint256 notificationId) view returns (address owner,uint256 requestId,uint256 caseId,uint256 chainId,uint256 amountWei,address destination,uint64 expiresAt,string message,uint64 createdAt)",
  "event RecoveryNotificationCreated(uint256 indexed notificationId,uint256 indexed requestId,address indexed owner,uint256 caseId,uint256 chainId,uint256 amountWei,address destination,uint64 expiresAt,string message)"
];

export function getRecoveryNotificationRegistry() {
  const rpcUrl = process.env.RECOVERY_REGISTRY_RPC_URL || process.env.RPC_URL;
  const registryAddress = process.env.RECOVERY_NOTIFICATION_REGISTRY_ADDRESS;
  const operatorKey = process.env.RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY;
  const expectedOperatorAddress = process.env.RECOVERY_REGISTRY_OPERATOR_ADDRESS;

  if (!rpcUrl || !registryAddress || !operatorKey) return null;
  if (ethers.isAddress(operatorKey)) throw new Error("RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY recebeu um endereco publico.");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(operatorKey, provider);
  if (expectedOperatorAddress && wallet.address.toLowerCase() !== expectedOperatorAddress.toLowerCase()) {
    throw new Error("Operator key/address mismatch: key derives " + wallet.address + ", expected " + expectedOperatorAddress);
  }
  return new ethers.Contract(registryAddress, RECOVERY_NOTIFICATION_REGISTRY_ABI, wallet);
}

export function isRecoveryNotificationRegistryConfigured() {
  return Boolean(
    (process.env.RECOVERY_REGISTRY_RPC_URL || process.env.RPC_URL) &&
    process.env.RECOVERY_NOTIFICATION_REGISTRY_ADDRESS &&
    process.env.RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY &&
    !ethers.isAddress(process.env.RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY)
  );
}

export async function createOnChainRecoveryNotification({
  owner, requestId, caseId, chainId, amountWei, destination, expiresAt, message
}) {
  const registry = getRecoveryNotificationRegistry();
  if (!registry) throw new Error("recovery_notification_registry_not_configured");

  const tx = await registry.createNotification(
    owner,
    BigInt(requestId),
    BigInt(caseId),
    BigInt(chainId),
    BigInt(amountWei || 0),
    destination,
    Math.floor(new Date(expiresAt).getTime() / 1000),
    message
  );
  const receipt = await tx.wait();

  const iface = new ethers.Interface(RECOVERY_NOTIFICATION_REGISTRY_ABI);
  let notificationId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "RecoveryNotificationCreated") {
        notificationId = parsed.args.notificationId.toString();
        break;
      }
    } catch {}
  }

  if (!notificationId) throw new Error("recovery_notification_id_not_found");
  return { notificationId, txHash: receipt.hash };
}
