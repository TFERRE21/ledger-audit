# ledger-audit

Toolkit for blockchain transaction auditing, reconciliation and evidence-based recovery research.

## Scope
- Public blockchain indexing and transaction analysis
- Detection of failed, reverted and anomalous transactions
- Reconciliation between exchange records and on-chain data
- Evidence and case management
- Testnet-first validation
- No private keys or seed phrases
- No automated transfer of third-party assets

## Architecture
- scanner/ — discovery and transaction collection
- indexer/ — normalized blockchain data
- analyzers/ — anomaly and reconciliation rules
- blockchain/ — chain adapters
- exchange/ — read-only exchange adapters
- recovery/ — eligibility/evidence assessment only
- database/ — schema and persistence
- api/ — service endpoints
- dashboard/ — future UI
- tests/ — automated tests

## Security
Use read-only API credentials whenever possible. Never commit secrets.
