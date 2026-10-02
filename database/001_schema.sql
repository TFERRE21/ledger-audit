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
  token_transfers JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain, tx_hash)
);

CREATE TABLE IF NOT EXISTS investigation_cases (
  id BIGSERIAL PRIMARY KEY,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  confidence TEXT NOT NULL,
  ownership_status TEXT NOT NULL DEFAULT 'unknown',
  recovery_status TEXT NOT NULL DEFAULT 'not_established',
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_address);
CREATE INDEX IF NOT EXISTS idx_cases_confidence ON investigation_cases(confidence);
CREATE INDEX IF NOT EXISTS idx_cases_recovery ON investigation_cases(recovery_status);
