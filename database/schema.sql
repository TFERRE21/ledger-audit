-- PostgreSQL schema for normalized, read-only blockchain observations.

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number BIGINT,
  from_address TEXT,
  to_address TEXT,
  value TEXT,
  status TEXT,
  gas_used TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_transactions_from
  ON transactions(from_address);

CREATE INDEX IF NOT EXISTS idx_transactions_to
  ON transactions(to_address);
