import test from "node:test";
import assert from "node:assert/strict";
import { investigateTransaction } from "../analyzers/caseEngine.js";

test("creates a high-confidence value mismatch finding", () => {
  const result = investigateTransaction({
    chain: "ethereum",
    hash: "0x123",
    expectedValue: "100",
    receivedValue: "90",
    to: "0xabc"
  });

  assert.equal(result.confidence, "high");
  assert.equal(result.findings[0].type, "value_mismatch");
  assert.equal(result.ownershipStatus, "unknown");
});

test("detects reverted transaction", () => {
  const result = investigateTransaction({
    chain: "ethereum",
    hash: "0x456",
    status: "reverted"
  });

  assert.equal(result.confidence, "medium");
  assert.equal(result.findings[0].type, "failed_transaction");
});
