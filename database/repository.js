import { pool } from "./connection.js";

const schemaReady = pool.query(`
  ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS token_transfers JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE investigation_cases
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  CREATE TABLE IF NOT EXISTS recovery_events (
    id BIGSERIAL PRIMARY KEY,
    chain TEXT NOT NULL,
    case_id BIGINT REFERENCES investigation_cases(id) ON DELETE SET NULL,
    tx_hash TEXT,
    asset TEXT,
    amount TEXT,
    gas_amount TEXT,
    net_amount TEXT,
    destination TEXT,
    status TEXT NOT NULL DEFAULT 'blocked',
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_recovery_events_status ON recovery_events(status);
  CREATE INDEX IF NOT EXISTS idx_recovery_events_chain ON recovery_events(chain);
  CREATE TABLE IF NOT EXISTS scan_progress (
    chain TEXT PRIMARY KEY,
    next_block BIGINT NOT NULL DEFAULT 0,
    current_block BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    batch_transactions BIGINT NOT NULL DEFAULT 0,
    batch_cases BIGINT NOT NULL DEFAULT 0,
    speed_blocks_per_second DOUBLE PRECISION NOT NULL DEFAULT 0,
    eta_seconds DOUBLE PRECISION,
    log_line TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE scan_progress
    ADD COLUMN IF NOT EXISTS current_block BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle';
  ALTER TABLE scan_progress
    ADD COLUMN IF NOT EXISTS batch_transactions BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress
    ADD COLUMN IF NOT EXISTS batch_cases BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress
    ADD COLUMN IF NOT EXISTS speed_blocks_per_second DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress
    ADD COLUMN IF NOT EXISTS eta_seconds DOUBLE PRECISION;
  ALTER TABLE scan_progress
    ADD COLUMN IF NOT EXISTS log_line TEXT;
  CREATE TABLE IF NOT EXISTS scan_logs (
    id BIGSERIAL PRIMARY KEY,
    chain TEXT NOT NULL,
    block_number BIGINT,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    opportunity BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_scan_logs_chain_created ON scan_logs(chain, created_at DESC);
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

export async function getScanProgress(chain, defaultBlock = 0) {
  await schemaReady;
  const result = await pool.query(
    `SELECT next_block, current_block, status, batch_transactions, batch_cases, speed_blocks_per_second, eta_seconds, log_line, updated_at
     FROM scan_progress WHERE chain = $1 LIMIT 1`,
    [chain]
  );
  if (!result.rows.length) {
    await pool.query(
      `INSERT INTO scan_progress (chain, next_block, current_block, status)
       VALUES ($1,$2,$2,'idle') ON CONFLICT (chain) DO NOTHING`,
      [chain, defaultBlock]
    );
    return defaultBlock;
  }
  return Number(result.rows[0].next_block);
}

export async function setScanProgress(chain, nextBlock, details = {}) {
  await schemaReady;
  await pool.query(
    `INSERT INTO scan_progress
       (chain, next_block, current_block, status, batch_transactions, batch_cases, speed_blocks_per_second, eta_seconds, log_line, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (chain)
     DO UPDATE SET
       next_block = EXCLUDED.next_block,
       current_block = EXCLUDED.current_block,
       status = EXCLUDED.status,
       batch_transactions = EXCLUDED.batch_transactions,
       batch_cases = EXCLUDED.batch_cases,
       speed_blocks_per_second = EXCLUDED.speed_blocks_per_second,
       eta_seconds = EXCLUDED.eta_seconds,
       log_line = EXCLUDED.log_line,
       updated_at = NOW()`,
    [
      chain,
      nextBlock,
      Number(details.currentBlock ?? nextBlock),
      details.status ?? 'idle',
      Number(details.batchTransactions ?? 0),
      Number(details.batchCases ?? 0),
      Number(details.speedBlocksPerSecond ?? 0),
      details.etaSeconds == null ? null : Number(details.etaSeconds),
      details.logLine ?? null
    ]
  );
}

export async function getScanStatus(chain) {
  await schemaReady;
  const result = await pool.query(
    `SELECT chain, next_block, current_block, status, batch_transactions,
            batch_cases, speed_blocks_per_second, eta_seconds, log_line, updated_at
     FROM scan_progress WHERE chain = $1 LIMIT 1`,
    [chain]
  );
  return result.rows[0] ?? null;
}


export async function saveScanLog({ chain, blockNumber = null, level = "info", message, opportunity = false }) {
  await schemaReady;
  await pool.query(
    `INSERT INTO scan_logs (chain, block_number, level, message, opportunity)
     VALUES ($1,$2,$3,$4,$5)`,
    [chain, blockNumber, level, message, Boolean(opportunity)]
  );
}
