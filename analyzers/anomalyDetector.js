export function detectAnomalies(tx) {
  const findings = [];
  if (!tx) return findings;
  if (tx.status === 0 || tx.status === "failed" || tx.status === "reverted") {
    findings.push({ type: "failed_transaction", severity: "medium" });
  }
  if (tx.expectedValue != null && tx.receivedValue != null && tx.expectedValue !== tx.receivedValue) {
    findings.push({ type: "value_mismatch", severity: "high" });
  }
  return findings;
}
