const TYPES = {
  FAILED: "failed_transaction",
  VALUE_MISMATCH: "value_mismatch",
  MISSING_DESTINATION: "missing_destination",
  CONTRACT_INTERACTION: "contract_interaction",
  POSSIBLE_LOST_FUNDS: "possible_lost_funds",
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

  if (tx.expectedValue != null && tx.receivedValue != null &&
      String(tx.expectedValue) !== String(tx.receivedValue)) {
    findings.push({ type: TYPES.VALUE_MISMATCH, severity: "high" });
    evidence.push("expected_and_received_values_differ");
  }

  if (tx.expectedDestination && tx.to &&
      tx.expectedDestination.toLowerCase() !== tx.to.toLowerCase()) {
    findings.push({ type: TYPES.MISSING_DESTINATION, severity: "high" });
    evidence.push("destination_differs_from_expected");
  }

  if (tx.to && tx.input && tx.input !== "0x") {
    findings.push({ type: TYPES.CONTRACT_INTERACTION, severity: "low" });
    evidence.push("non_empty_input_to_destination");
  }

  if (tx.status !== "failed" && tx.value && tx.value !== "0x0" && tx.value !== "0" && isZeroAddress(tx.to)) {
    findings.push({ type: TYPES.POSSIBLE_LOST_FUNDS, severity: "high" });
    evidence.push("non_zero_value_with_zero_destination");
  }

  const ownerVerified = tx.ownerVerified === true;
  const hasActionableFinding = findings.length > 0;

  if (hasActionableFinding && !ownerVerified) {
    findings.push({ type: TYPES.NEEDS_OWNERSHIP_VERIFICATION, severity: "medium" });
    evidence.push("ownership_or_recovery_authority_not_verified");
  }

  const confidence =
    findings.some(f => f.severity === "high") ? "high" :
    findings.some(f => f.severity === "medium") ? "medium" :
    findings.length ? "low" : "none";

  const recoveryEligible =
    ownerVerified === true &&
    tx.recoveryAuthorityVerified === true &&
    tx.recoveryMechanismVerified === true &&
    hasActionableFinding;

  const tokenTransfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
  const metadata = {
    asset: tokenTransfers.length ? "ERC-20" : "ETH",
    tokenTransfers,
    recoveryDestination: recoveryEligible ? (tx.authorizedDestination ?? null) : null,
    recoveryPlan: recoveryEligible
      ? "Route only the legitimately recoverable asset to the configured authorized destination after explicit verification."
      : null
  };

  return {
    hash: tx.hash ?? null,
    chain: tx.chain ?? null,
    blockNumber: tx.blockNumber ?? null,
    findings,
    evidence,
    metadata,
    confidence,
    ownershipStatus: ownerVerified ? "verified" : "unknown",
    recoveryStatus: recoveryEligible ? "authorized_pending_execution" : "not_authorized",
    recoveryEligible,
    ownerVerified,
    recoveryAuthorityVerified: tx.recoveryAuthorityVerified === true,
    recoveryMechanismVerified: tx.recoveryMechanismVerified === true,
    recoveryMechanismType: tx.recoveryMechanismType ?? null
  };
}

export { TYPES };
