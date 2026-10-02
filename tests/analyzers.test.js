import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies } from "../analyzers/anomalyDetector.js";

test("detects reverted transactions", () => {
  const findings = detectAnomalies({ status: "reverted" });
  assert.equal(findings[0].type, "failed_transaction");
});

test("detects value mismatch", () => {
  const findings = detectAnomalies({ expectedValue: "100", receivedValue: "90" });
  assert.equal(findings[0].type, "value_mismatch");
});
