const TYPES = {
  FAILED: "failed_transaction",
  VALUE_MISMATCH: "value_mismatch",
  MISSING_DESTINATION: "missing_destination",
  CONTRACT_INTERACTION: "contract_interaction",
  POSSIBLE_LOST_FUNDS: "possible_lost_funds",
  TOKEN_TRANSFER: "token_transfer",
  NEEDS_OWNERSHIP_VERIFICATION: "needs_ownership_verification"
};

function isZeroAddress(address) {
  return !address || /^0x0{40}$/i.test(address);
}

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

  if (
    tx.expectedDestination &&
    tx.to &&
    tx.expectedDestination.toLowerCase() !== tx.to.toLowerCase()
  ) {
    findings.push({ type: TYPES.MISSING_DESTINATION, severity: "high" });
    evidence.push("destination_differs_from_expected");
  }

  if (tx.to && tx.input && tx.input !== "0x") {
    findings.push({ type: TYPES.CONTRACT_INTERACTION, severity: "low" });
    evidence.push("non_empty_input_to_destination");
  }

  if (tx.value && tx.value !== "0x0" && tx.value !== "0") {
    if (isZeroAddress(tx.to)) {
      findings.push({ type: TYPES.POSSIBLE_LOST_FUNDS, severity: "high" });
      evidence.push("non_zero_value_with_zero_destination");
    }
  }

  if (Array.isArray(tx.tokenTransfers) && tx.tokenTransfers.length > 0) {
    findings.push({ type: TYPES.TOKEN_TRANSFER, severity: "low" });
    evidence.push("token_transfer_data_present");

    if (!tx.ownerVerified) {
      findings.push({ type: TYPES.NEEDS_OWNERSHIP_VERIFICATION, severity: "medium" });
      evidence.push("ownership_not_verified");
    }
  }

  const confidence =
    findings.some(f => f.severity === "high") ? "high" :
    findings.some(f => f.severity === "medium") ? "medium" :
    findings.length ? "low" : "none";

  return {
    hash: tx.hash ?? null,
    chain: tx.chain ?? null,
    findings,
    evidence,
    confidence,
    ownershipStatus: tx.ownerVerified ? "verified" : "unknown",
    recoveryStatus: "not_established"
  };
}

export { TYPES };
