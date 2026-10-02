import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTransaction } from "../indexer/normalizer.js";

test("normalizes an EVM transaction", () => {
  const tx = normalizeTransaction({
    hash: "0xabc",
    blockNumber: 10,
    from: "0xfrom",
    to: "0xto",
    value: "1000"
  }, "evm");

  assert.equal(tx.hash, "0xabc");
  assert.equal(tx.blockNumber, 10);
  assert.equal(tx.value, "1000");
  assert.equal(tx.chain, "evm");
});
