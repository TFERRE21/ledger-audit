import { pool } from "./connection.js";

export async function saveTransaction(tx) {
  const query = `
    INSERT INTO transactions
      (chain, tx_hash, block_number, from_address, to_address, value, status, gas_used)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (chain, tx_hash)
    DO UPDATE SET
      block_number = EXCLUDED.block_number,
      from_address = EXCLUDED.from_address,
      to_address = EXCLUDED.to_address,
      value = EXCLUDED.value,
      status = EXCLUDED.status,
      gas_used = EXCLUDED.gas_used
    RETURNING id
  `;
  const values = [tx.chain, tx.hash, tx.blockNumber, tx.from, tx.to, tx.value, tx.status, tx.gasUsed];
  const result = await pool.query(query, values);
  return result.rows[0].id;
}

export async function saveCase(caseData) {
  const query = `
    INSERT INTO investigation_cases
      (chain, tx_hash, confidence, ownership_status, recovery_status, findings, evidence)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
    ON CONFLICT (chain, tx_hash)
    DO UPDATE SET
      confidence = EXCLUDED.confidence,
      findings = EXCLUDED.findings,
      evidence = EXCLUDED.evidence,
      updated_at = NOW()
    RETURNING id
  `;
  const values = [
    caseData.chain, caseData.hash, caseData.confidence,
    caseData.ownershipStatus, caseData.recoveryStatus,
    JSON.stringify(caseData.findings), JSON.stringify(caseData.evidence)
  ];
  const result = await pool.query(query, values);
  return result.rows[0].id;
}
