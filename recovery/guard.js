const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function normalizeAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value) ? value.toLowerCase() : null;
}

export function evaluateRecoveryGate({
  recoveryMode,
  autoRecovery,
  destination,
  caseData,
  sourceAddress,
  authorityAddress,
  mechanismVerified,
  signerAddress
}) {
  const reasons = [];
  const source = normalizeAddress(sourceAddress);
  const authority = normalizeAddress(authorityAddress);
  const signer = normalizeAddress(signerAddress);
  const target = normalizeAddress(destination);

  if (String(recoveryMode || "DRY_RUN").toUpperCase() !== "AUTO") {
    reasons.push("recovery_mode_not_auto");
  }
  if (autoRecovery !== true) {
    reasons.push("auto_recovery_disabled");
  }
  if (!target) {
    reasons.push("authorized_destination_not_configured");
  }
  if (caseData?.monetizationQueue === true && caseData?.recoveryEligible !== true) {
    reasons.push("monetization_queue_requires_verified_recovery");
  }
  if (!caseData?.recoveryEligible) {
    reasons.push("case_not_recovery_eligible");
  }
  if (caseData?.ownerVerified !== true) {
    reasons.push("owner_not_verified");
  }
  if (caseData?.recoveryAuthorityVerified !== true) {
    reasons.push("recovery_authority_not_verified");
  }
  if (mechanismVerified !== true && caseData?.recoveryMechanismVerified !== true) {
    reasons.push("recovery_mechanism_not_verified");
  }
  if (!authority) {
    reasons.push("recovery_authority_address_missing");
  }
  if (!signer) {
    reasons.push("recovery_signer_not_configured");
  }
  if (authority && signer && authority !== signer) {
    reasons.push("signer_does_not_match_verified_authority");
  }

  // For a normal EOA recovery, the signer must control the source account.
  // Contract recoveries require a separately verified owner/admin mechanism.
  if (source && signer && source !== signer && caseData?.recoveryMechanismType === "EOA_TRANSFER") {
    reasons.push("signer_does_not_control_source");
  }

  return {
    ready: reasons.length === 0,
    reasons,
    destination: target,
    source,
    authority,
    signer
  };
}

export function buildRecoveryPlan(input) {
  const gate = evaluateRecoveryGate(input);
  return {
    ready: gate.ready,
    status: gate.ready ? "ready_for_external_signer" : "blocked",
    gate,
    chain: input.caseData?.chain ?? null,
    txHash: input.caseData?.hash ?? null,
    destination: gate.destination,
    source: gate.source
  };
}
