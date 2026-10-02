# Deployment

The project is prepared for Docker-based deployment.

## Local

1. Copy .env.example to .env.
2. Set POSTGRES_PASSWORD.
3. Set DATABASE_URL to the internal Compose address:
   postgresql://ledger:YOUR_PASSWORD@postgres:5432/ledger_audit
4. Set RPC_URL.
5. Run:

```bash
docker compose up -d --build
```

6. Check:

```bash
curl http://localhost:3000/health
```

## iContainer

Deploy the repository as a Docker Compose project or equivalent container stack. Keep secrets in the platform environment variables, not in Git.

The application exposes port 3000. PostgreSQL data is stored in the named volume `ledger_audit_pg`.

The first production scan should remain bounded. Increase scan ranges only after validating database throughput and RPC limits.
