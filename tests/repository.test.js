import test from "node:test";
import assert from "node:assert/strict";

test("repository exports persistence functions", async () => {
  const module = await import("../database/repository.js");
  assert.equal(typeof module.saveTransaction, "function");
  assert.equal(typeof module.saveCase, "function");
});
