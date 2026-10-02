# ledger-audit

Read-only blockchain transaction auditing and reconciliation toolkit.

## Current components

- EVM JSON-RPC reader
- Bounded block scanner
- Transaction normalizer
- Anomaly/case engine
- PostgreSQL schema and persistence foundation
- Binance adapter placeholder restricted to read-only data
- Docker + PostgreSQL deployment
- Automated tests

## Safety model

Detection is not proof of ownership or recoverability. The system does not contain private keys, seed phrases, signing logic, withdrawal logic or automatic transfer of third-party assets.

## Run

```bash
cp .env.example .env
docker compose up -d --build
```

Health: `/health`

Scan: `docker compose exec app npm run scan`
