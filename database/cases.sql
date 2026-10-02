CREATE TABLE IF NOT EXISTS investigation_cases (
  id BIGSERIAL PRIMARY KEY,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  confidence TEXT NOT NULL,
  ownership_status TEXT NOT NULL DEFAULT 'unknown',
  recovery_status TEXT NOT NULL DEFAULT 'not_established',
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_cases_confidence
  ON investigation_cases(confidence);

CREATE INDEX IF NOT EXISTS idx_cases_recovery
  ON investigation_cases(recovery_status);
