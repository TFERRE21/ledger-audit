import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pool } from "../database/connection.js";

const port = Number(process.env.PORT || 3000);

async function queryDatabase(sql, params = []) {
  if (!process.env.DATABASE_URL) {
    const error = new Error("DATABASE_URL is not configured");
    error.code = "DB_NOT_CONFIGURED";
    throw error;
  }
  return pool.query(sql, params);
}

async function handle(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    try {
      const html = await readFile(new URL("./dashboard.html", import.meta.url), "utf8");
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    } catch {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("dashboard_unavailable");
    }
    return;
  }

  res.setHeader("content-type", "application/json; charset=utf-8");

  if (pathname === "/health") {
    res.end(JSON.stringify({
      ok: true,
      service: "ledger-audit",
      environment: process.env.NODE_ENV || "development"
    }));
    return;
  }

  if (pathname === "/") {
    res.end(JSON.stringify({
      service: "ledger-audit",
      status: "online",
      dashboard: "/dashboard",
      endpoints: ["/health", "/api/stats", "/api/transactions", "/api/cases"]
    }));
    return;
  }

  if (pathname === "/api/recovery") {
    res.end(JSON.stringify({
      ok: true,
      mode: String(process.env.RECOVERY_MODE || "DRY_RUN").toUpperCase(),
      authorizedDestinationConfigured: Boolean(process.env.AUTHORIZED_DESTINATION_ADDRESS),
      authorizedDestination: process.env.AUTHORIZED_DESTINATION_ADDRESS || null,
      execution: "disabled_until_ownership_and_recovery_mechanism_are_verified"
    }));
    return;
  }

  if (pathname === "/api/stats") {
    try {
      const result = await queryDatabase(`
        SELECT
          (SELECT COUNT(*) FROM transactions) AS transactions,
          (SELECT COUNT(*) FROM investigation_cases) AS cases,
          (SELECT COUNT(*) FROM investigation_cases WHERE confidence = 'high') AS high_confidence_cases,
          (SELECT COUNT(*) FROM investigation_cases WHERE recovery_status = 'authorized_pending_execution') AS recovery_candidates
      `);
      res.end(JSON.stringify({ ok: true, stats: result.rows[0] }));
    } catch (error) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: error.code === "DB_NOT_CONFIGURED" ? "database_not_configured" : "database_unavailable" }));
    }
    return;
  }

  if (pathname === "/api/transactions") {
    try {
      const result = await queryDatabase(`
        SELECT chain, tx_hash, block_number, from_address, to_address, value, status, gas_used, token_transfers, observed_at
        FROM transactions
        ORDER BY id DESC
        LIMIT 100
      `);
      res.end(JSON.stringify({ ok: true, count: result.rows.length, transactions: result.rows }));
    } catch (error) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: error.code === "DB_NOT_CONFIGURED" ? "database_not_configured" : "database_unavailable" }));
    }
    return;
  }

  if (pathname === "/api/cases") {
    try {
      const result = await queryDatabase(`
        SELECT id, chain, tx_hash, confidence, ownership_status, recovery_status,
               findings, evidence, metadata, created_at, updated_at
        FROM investigation_cases
        ORDER BY id DESC
        LIMIT 100
      `);
      res.end(JSON.stringify({ ok: true, count: result.rows.length, cases: result.rows }));
    } catch (error) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: error.code === "DB_NOT_CONFIGURED" ? "database_not_configured" : "database_unavailable" }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
}

createServer((req, res) => {
  handle(req, res).catch(() => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "internal_error" }));
  });
}).listen(port, "0.0.0.0", () => {
  console.log(`ledger-audit listening on 0.0.0.0:${port}`);
});
