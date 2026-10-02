import { pool } from "./connection.js";

const schemaReady = pool.query(`
  ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS token_transfers JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE investigation_cases
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
`);

export async function saveTransaction(tx) {
  await schemaReady;
  const query = `
    INSERT INTO transactions
      (chain, tx_hash, block_number, from_address, to_address, value, status, gas_used, token_transfers)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT (chain, tx_hash)
    DO UPDATE SET
      block_number = EXCLUDED.block_number,
      from_address = EXCLUDED.from_address,
      to_address = EXCLUDED.to_address,
      value = EXCLUDED.value,
      status = EXCLUDED.status,
      gas_used = EXCLUDED.gas_used,
      token_transfers = EXCLUDED.token_transfers
    RETURNING id
  `;
  const values = [
    tx.chain, tx.hash, tx.blockNumber, tx.from, tx.to, tx.value, tx.status,
    tx.gasUsed, JSON.stringify(tx.tokenTransfers ?? [])
  ];
  const result = await pool.query(query, values);
  return result.rows[0].id;
}

export async function saveCase(caseData) {
  await schemaReady;
  const query = `
    INSERT INTO investigation_cases
      (chain, tx_hash, confidence, ownership_status, recovery_status, findings, evidence, metadata)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
    ON CONFLICT (chain, tx_hash)
    DO UPDATE SET
      confidence = EXCLUDED.confidence,
      findings = EXCLUDED.findings,
      ownership_status = EXCLUDED.ownership_status,
      recovery_status = EXCLUDED.recovery_status,
      evidence = EXCLUDED.evidence,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id
  `;
  const values = [
    caseData.chain, caseData.hash, caseData.confidence,
    caseData.ownershipStatus, caseData.recoveryStatus,
    JSON.stringify(caseData.findings), JSON.stringify(caseData.evidence),
    JSON.stringify(caseData.metadata ?? {})
  ];
  const result = await pool.query(query, values);
  return result.rows[0].id;
}
