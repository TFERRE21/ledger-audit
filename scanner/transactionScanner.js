export function classifyTransaction(tx) {
  if (!tx) return "unknown";
  if (tx.status === 0 || tx.status === "failed" || tx.status === "reverted") return "failed_or_reverted";
  if (tx.status === 1 || tx.status === "success") return "success";
  return "unknown";
}
