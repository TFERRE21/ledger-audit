const TYPES = {
  FAILED: "failed_transaction",
  VALUE_MISMATCH: "value_mismatch",
  MISSING_DESTINATION: "missing_destination",
  CONTRACT_INTERACTION: "contract_interaction"
};

export function investigateTransaction(tx) {
  if (!tx) throw new Error("transaction is required");

  const findings = [];
  const evidence = [];

  if (tx.status === 0 || tx.status === "failed" || tx.status === "reverted") {
    findings.push({ type: TYPES.FAILED, severity: "medium" });
    evidence.push("transaction_status_indicates_failure");
  }

  if (
    tx.expectedValue != null &&
    tx.receivedValue != null &&
    String(tx.expectedValue) !== String(tx.receivedValue)
  ) {
    findings.push({ type: TYPES.VALUE_MISMATCH, severity: "high" });
    evidence.push("expected_and_received_values_differ");
  }

  if (tx.expectedDestination && tx.to && tx.expectedDestination.toLowerCase() !== tx.to.toLowerCase()) {
    findings.push({ type: TYPES.MISSING_DESTINATION, severity: "high" });
    evidence.push("destination_differs_from_expected");
  }

  if (tx.to && tx.input && tx.input !== "0x") {
    findings.push({ type: TYPES.CONTRACT_INTERACTION, severity: "low" });
    evidence.push("non_empty_input_to_destination");
  }

  const confidence =
    findings.some(f => f.severity === "high") ? "high" :
    findings.length ? "medium" : "none";

  return {
    hash: tx.hash ?? null,
    chain: tx.chain ?? null,
    findings,
    evidence,
    confidence,
    ownershipStatus: "unknown",
    recoveryStatus: "not_established"
  };
}

export { TYPES };
