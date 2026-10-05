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

-- Fast filtering for dashboard queries involving transactions >= 1 ETH.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS value_wei_numeric NUMERIC
    GENERATED ALWAYS AS (
      CASE
        WHEN value ~ '^[0-9]+(\\.[0-9]+)?
CREATE INDEX IF NOT EXISTS idx_cases_confidence ON investigation_cases(confidence);
CREATE INDEX IF NOT EXISTS idx_cases_recovery ON investigation_cases(recovery_status);


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
 THEN value::numeric
        ELSE NULL
      END
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_transactions_value_wei_numeric
  ON transactions(value_wei_numeric)
  WHERE value_wei_numeric >= 1000000000000000000;
CREATE INDEX IF NOT EXISTS idx_cases_confidence ON investigation_cases(confidence);
CREATE INDEX IF NOT EXISTS idx_cases_recovery ON investigation_cases(recovery_status);


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
