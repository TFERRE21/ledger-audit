export function assessRecovery(caseData) {
  const evidence = caseData?.evidence ?? [];
  const ownership = caseData?.ownershipStatus ?? "unknown";
  if (ownership === "verified" && evidence.length > 0) return "eligible_for_review";
  if (ownership === "unknown") return "needs_ownership_evidence";
  return "not_established";
}
