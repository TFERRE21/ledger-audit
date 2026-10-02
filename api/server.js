import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pool } from "../database/connection.js";
import { rpcCall } from "../indexer/rpcClient.js";
import {
  buildOwnerAuthorizationMessage,
  verifyOwnerAuthorization
} from "../recovery/ownerAuthorization.js";

const port = Number(process.env.PORT || 3000);
let marketPriceCache = { expiresAt: 0, data: null };
const scannerRestartDelayMs = Math.max(3000, Number(process.env.SCANNER_RESTART_DELAY_MS || 5000));
let scannerProcess = null;
let scannerRestartTimer = null;
let shuttingDown = false;

const schemaReady = pool.query(`
  ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS token_transfers JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE investigation_cases
    ADD COLUMN IF NOT EXISTS block_number BIGINT;
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
  CREATE TABLE IF NOT EXISTS recovery_authorizations (
    id BIGSERIAL PRIMARY KEY,
    case_id BIGINT REFERENCES investigation_cases(id) ON DELETE CASCADE,
    owner_address TEXT NOT NULL,
    destination TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    message TEXT NOT NULL,
    signature TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    authorized_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_recovery_authorizations_case
    ON recovery_authorizations(case_id);
  CREATE INDEX IF NOT EXISTS idx_recovery_authorizations_status
    ON recovery_authorizations(status);
  CREATE TABLE IF NOT EXISTS scan_progress (
    chain TEXT PRIMARY KEY,
    next_block BIGINT NOT NULL DEFAULT 0,
    current_block BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    batch_transactions BIGINT NOT NULL DEFAULT 0,
    batch_cases BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE scan_progress ADD COLUMN IF NOT EXISTS current_block BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle';
  ALTER TABLE scan_progress ADD COLUMN IF NOT EXISTS batch_transactions BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress ADD COLUMN IF NOT EXISTS batch_cases BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress ADD COLUMN IF NOT EXISTS speed_blocks_per_second DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE scan_progress ADD COLUMN IF NOT EXISTS eta_seconds DOUBLE PRECISION;
  ALTER TABLE scan_progress ADD COLUMN IF NOT EXISTS log_line TEXT;
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
  CREATE TABLE IF NOT EXISTS contract_findings (
    id BIGSERIAL PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, block_number BIGINT,
    eth_balance_wei TEXT NOT NULL DEFAULT '0', code_size_bytes INTEGER NOT NULL DEFAULT 0,
    owner_address TEXT, admin_address TEXT, signals JSONB NOT NULL DEFAULT '[]'::jsonb,
    method_signals JSONB NOT NULL DEFAULT '[]'::jsonb, evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    potential BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(chain,address)
  );
  CREATE INDEX IF NOT EXISTS idx_contract_findings_potential ON contract_findings(potential);
  ALTER TABLE contract_findings ADD COLUMN IF NOT EXISTS token_balances JSONB NOT NULL DEFAULT '[]'::jsonb;
`);

async function queryDatabase(sql, params = []) {
  await schemaReady;
  if (!process.env.DATABASE_URL) {
    const error = new Error("DATABASE_URL is not configured");
    error.code = "DB_NOT_CONFIGURED";
    throw error;
  }
  return pool.query(sql, params);
}

async function markScannerRestarting(reason) {
  try {
    await queryDatabase(`
      UPDATE scan_progress
      SET status = 'scanner_restarting',
          log_line = $2,
          updated_at = NOW()
      WHERE chain = $1
    `, [process.env.CHAIN || "ethereum", reason]);
  } catch {}
}

function scheduleScannerRestart(reason) {
  if (shuttingDown || scannerRestartTimer) return;
  const autostart = String(process.env.SCANNER_AUTOSTART ?? "true").toLowerCase() === "true";
  if (!autostart) return;

  console.error(`[SCANNER] restart scheduled in ${scannerRestartDelayMs}ms: ${reason}`);
  void markScannerRestarting(reason);
  scannerRestartTimer = setTimeout(() => {
    scannerRestartTimer = null;
    startScanner();
  }, scannerRestartDelayMs);
}

function startScanner() {
  const autostart = String(process.env.SCANNER_AUTOSTART ?? "true").toLowerCase() === "true";
  if (!autostart || scannerProcess || shuttingDown) return;

  console.log("[SCANNER] autostart enabled");
  scannerProcess = spawn(process.execPath, ["scanner/runScan.js"], {
    stdio: "inherit",
    env: process.env
  });

  scannerProcess.on("error", error => {
    console.error("[SCANNER] process error:", error.message);
    scannerProcess = null;
    scheduleScannerRestart(`process_error: ${error.message}`);
  });

  scannerProcess.on("exit", (code, signal) => {
    console.log(`[SCANNER] process exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    scannerProcess = null;
    if (!shuttingDown) {
      scheduleScannerRestart(`exit code=${code ?? "null"} signal=${signal ?? "none"}`);
    }
  });
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request_body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function isEthAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function authorizationDestination() {
  return process.env.AUTHORIZED_DESTINATION_ADDRESS || null;
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

  if (pathname.startsWith("/recovery/authorize/")) {
    try {
      const html = await readFile(new URL("./authorization.html", import.meta.url), "utf8");
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    } catch {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("authorization_page_unavailable");
    }
    return;
  }

  res.setHeader("content-type", "application/json; charset=utf-8");

  if (pathname === "/health") {
    res.end(JSON.stringify({
      ok: true,
      service: "ledger-audit",
      environment: process.env.NODE_ENV || "development",
      scannerProcess: scannerProcess ? "running" : (scannerRestartTimer ? "restarting" : "stopped")
    }));
    return;
  }

  if (pathname === "/") {
    res.end(JSON.stringify({
      service: "ledger-audit",
      status: "online",
      dashboard: "/dashboard",
      endpoints: ["/health", "/api/stats", "/api/balances", "/api/transactions", "/api/cases", "/api/scanner/status"]
    }));
    return;
  }

  if (pathname === "/api/scanner/status") {
    try {
      const result = await queryDatabase(`
        SELECT chain, next_block, current_block, status,
               batch_transactions, batch_cases, speed_blocks_per_second, eta_seconds, log_line, updated_at
        FROM scan_progress
        ORDER BY updated_at DESC
        LIMIT 10
      `);
      const latest = await queryDatabase(`
        SELECT COUNT(*) AS transactions_last_60s
        FROM transactions
        WHERE observed_at >= NOW() - INTERVAL '60 seconds'
      `);
      const opportunities = await queryDatabase(`
        SELECT
          COUNT(*) FILTER (WHERE findings @> '[{"type":"possible_lost_funds"}]'::jsonb) AS potential_opportunities,
          COUNT(*) FILTER (WHERE recovery_status = 'authorized_pending_execution') AS authorized_opportunities
        FROM investigation_cases
      `);
      let latestBlock = null;
      try {
        const hex = await rpcCall(process.env.RPC_URL, "eth_blockNumber", []);
        latestBlock = Number.parseInt(hex, 16);
      } catch {}
      const firstActivityBlock = 46147;
      res.end(JSON.stringify({
        ok: true,
        process: scannerProcess ? "running" : (scannerRestartTimer ? "restarting" : "stopped"),
        configured: {
          autostart: String(process.env.SCANNER_AUTOSTART ?? "true").toLowerCase() === "true",
          historicalScan: String(process.env.HISTORICAL_SCAN || "false").toLowerCase() === "true",
          batchBlocks: Number(process.env.HISTORICAL_BATCH_BLOCKS || 1000),
          monitor: String(process.env.MONITOR || "false").toLowerCase() === "true"
        },
        scanners: result.rows,
        activity: latest.rows[0],
        network: { latestBlock, firstActivityBlock },
        opportunities: opportunities.rows[0]
      }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ok:false,error:"database_unavailable"}));
    }
    return;
  }

  if (pathname === "/api/scanner/logs") {
    try {
      const result = await queryDatabase(`
        SELECT id, chain, block_number, level, message, opportunity, created_at
        FROM scan_logs
        ORDER BY id DESC
        LIMIT 100
      `);
      res.end(JSON.stringify({ok:true,logs:result.rows}));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ok:false,error:"database_unavailable"}));
    }
    return;
  }

  if (pathname === "/api/opportunities") {
    try {
      const result = await queryDatabase(`
        SELECT id, chain, tx_hash, confidence, ownership_status, recovery_status,
               findings, evidence, metadata, created_at, updated_at
        FROM investigation_cases
        WHERE findings @> '[{"type":"possible_lost_funds"}]'::jsonb
        ORDER BY id DESC
        LIMIT 100
      `);
      const contracts = await queryDatabase(`
        SELECT id, chain, address, block_number, eth_balance_wei, code_size_bytes,
               owner_address, admin_address, signals, method_signals, evidence, token_balances,
               potential, created_at, updated_at
        FROM contract_findings
        WHERE potential = TRUE
        ORDER BY id DESC
        LIMIT 100
      `);
      res.end(JSON.stringify({
        ok:true,
        count: result.rows.length + contracts.rows.length,
        opportunities: result.rows,
        contractOpportunities: contracts.rows
      }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ok:false,error:"database_unavailable"}));
    }
    return;
  }

  if (pathname === "/api/contracts") {
    try {
      const result = await queryDatabase(`
        SELECT id, chain, address, block_number, eth_balance_wei, code_size_bytes,
               owner_address, admin_address, signals, method_signals, evidence, token_balances,
               potential, created_at, updated_at
        FROM contract_findings
        ORDER BY potential DESC, id DESC
        LIMIT 200
      `);
      res.end(JSON.stringify({ok:true,count:result.rows.length,contracts:result.rows}));
    } catch {
      res.statusCode=503;
      res.end(JSON.stringify({ok:false,error:"database_unavailable"}));
    }
    return;
  }

  if (pathname === "/api/balances") {
    try {
      const contracts = await queryDatabase(`
        SELECT
          COUNT(*) FILTER (WHERE eth_balance_wei::numeric > 0) AS funded_contracts,
          COALESCE(SUM(eth_balance_wei::numeric), 0) AS contract_balance_wei
        FROM contract_findings
      `);
      const cases = await queryDatabase(`
        SELECT COALESCE(SUM(NULLIF(metadata->>'amount','')::numeric),0) AS case_amount
        FROM investigation_cases
        WHERE metadata->>'asset' = 'ETH'
      `);
      const wei = BigInt(String(contracts.rows[0]?.contract_balance_wei || "0"));
      const eth = Number(wei) / 1e18;
      res.end(JSON.stringify({
        ok:true,
        fundedContracts:Number(contracts.rows[0]?.funded_contracts || 0),
        contractBalanceWei:wei.toString(),
        contractBalanceEth:eth.toFixed(18),
        caseAmountEth:Number(cases.rows[0]?.case_amount || 0)
      }));
    } catch {
      res.statusCode=503;
      res.end(JSON.stringify({ok:false,error:"database_unavailable"}));
    }
    return;
  }

  if (pathname === "/api/prices") {
    try {
      const now = Date.now();
      if (marketPriceCache.data && marketPriceCache.expiresAt > now) {
        res.end(JSON.stringify({ ok: true, ...marketPriceCache.data, cached: true }));
        return;
      }
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd,brl");
      if (!response.ok) throw new Error(`market_http_${response.status}`);
      const price = await response.json();
      const ethUsd = Number(price?.ethereum?.usd || 0);
      const ethBrl = Number(price?.ethereum?.brl || 0);
      if (!(ethUsd > 0) || !(ethBrl > 0)) throw new Error("market_price_unavailable");
      const data = {
        source: "CoinGecko",
        fetchedAt: new Date().toISOString(),
        ethUsd,
        ethBrl
      };
      marketPriceCache = { expiresAt: now + 60000, data };
      res.end(JSON.stringify({ ok: true, ...data, cached: false }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: "market_price_unavailable" }));
    }
    return;
  }

  if (pathname === "/api/recovery") {
    const signerAddress = process.env.RECOVERY_SIGNER_ADDRESS || null;
    res.end(JSON.stringify({
      ok: true,
      mode: String(process.env.RECOVERY_MODE || "DRY_RUN").toUpperCase(),
      authorizedDestinationConfigured: Boolean(process.env.AUTHORIZED_DESTINATION_ADDRESS),
      authorizedDestination: process.env.AUTHORIZED_DESTINATION_ADDRESS || null,
      signerConfigured: Boolean(signerAddress),
      signerAddress,
      signerMode: process.env.RECOVERY_SIGNER_MODE || "external",
      execution: "disabled_until_ownership_and_recovery_mechanism_are_verified"
    }));
    return;
  }

  if (pathname.startsWith("/api/transactions/")) {
    const hash = decodeURIComponent(pathname.slice("/api/transactions/".length));
    try {
      const result = await queryDatabase(`
        SELECT chain, tx_hash, block_number, from_address, to_address, value, status,
               gas_used, token_transfers, observed_at
        FROM transactions
        WHERE tx_hash = $1
        LIMIT 1
      `, [hash]);
      if (!result.rows.length) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "transaction_not_found" }));
      } else {
        res.end(JSON.stringify({ ok: true, transaction: result.rows[0] }));
      }
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: "database_unavailable" }));
    }
    return;
  }

  if (pathname === "/api/recovery/authorization/create" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const caseId = Number(body.caseId);
      if (!Number.isInteger(caseId) || caseId <= 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "invalid_case_id" }));
        return;
      }

      const destination = body.destination || authorizationDestination();
      if (!isEthAddress(destination)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "invalid_authorized_destination" }));
        return;
      }

      const caseResult = await queryDatabase(`
        SELECT id, chain, tx_hash, confidence, ownership_status, recovery_status, metadata
        FROM investigation_cases
        WHERE id = $1
        LIMIT 1
      `, [caseId]);

      if (!caseResult.rows.length) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "case_not_found" }));
        return;
      }

      const caseData = caseResult.rows[0];
      const metadata = caseData.metadata || {};
      const ownerAddress = metadata.owner_address || metadata.ownerAddress || null;

      if (!metadata.recoveryEligible) {
        res.statusCode = 409;
        res.end(JSON.stringify({
          ok: false,
          error: "case_not_recovery_eligible"
        }));
        return;
      }

      if (!isEthAddress(ownerAddress)) {
        res.statusCode = 409;
        res.end(JSON.stringify({
          ok: false,
          error: "owner_address_not_configured_on_case"
        }));
        return;
      }

      const expiresAt = new Date(
        Date.now() + Number(process.env.RECOVERY_AUTHORIZATION_TTL_MINUTES || 30) * 60 * 1000
      );
      const nonce = randomBytes(24).toString("hex");

      const message = buildOwnerAuthorizationMessage({
        domain: req.headers.host || "ledger-audit",
        caseId: caseData.id,
        chain: caseData.chain || "ethereum",
        sourceAddress: metadata.source_address || metadata.sourceAddress || "",
        destination,
        amount: metadata.amount || "",
        expiresAt: expiresAt.toISOString(),
        nonce
      });

      const inserted = await queryDatabase(`
        INSERT INTO recovery_authorizations
          (case_id, owner_address, destination, nonce, message, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, case_id, owner_address, destination, nonce, message, status, expires_at, created_at
      `, [caseId, ownerAddress.toLowerCase(), destination.toLowerCase(), nonce, message, expiresAt]);

      res.end(JSON.stringify({
        ok: true,
        authorization: inserted.rows[0],
        authorizationUrl: `/recovery/authorize/${inserted.rows[0].id}`
      }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: error.message || "authorization_create_failed" }));
    }
    return;
  }

  if (pathname.startsWith("/api/recovery/authorization/") && req.method === "GET") {
    try {
      const id = Number(pathname.slice("/api/recovery/authorization/".length));
      if (!Number.isInteger(id) || id <= 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "invalid_authorization_id" }));
        return;
      }

      const result = await queryDatabase(`
        SELECT id, case_id, owner_address, destination, nonce, message, status, expires_at, created_at, authorized_at
        FROM recovery_authorizations
        WHERE id = $1
        LIMIT 1
      `, [id]);

      if (!result.rows.length) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "authorization_not_found" }));
        return;
      }

      res.end(JSON.stringify({ ok: true, authorization: result.rows[0] }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: "database_unavailable" }));
    }
    return;
  }

  if (pathname === "/api/recovery/authorize" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const authorizationId = Number(body.authorizationId);
      const signature = String(body.signature || "");

      if (!Number.isInteger(authorizationId) || authorizationId <= 0 || !signature) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "authorization_id_and_signature_required" }));
        return;
      }

      const authResult = await queryDatabase(`
        SELECT id, case_id, owner_address, destination, nonce, message, status, expires_at
        FROM recovery_authorizations
        WHERE id = $1
        LIMIT 1
      `, [authorizationId]);

      if (!authResult.rows.length) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "authorization_not_found" }));
        return;
      }

      const authorization = authResult.rows[0];

      if (authorization.status !== "pending") {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok: false, error: "authorization_not_pending" }));
        return;
      }

      if (new Date(authorization.expires_at).getTime() <= Date.now()) {
        await queryDatabase(
          `UPDATE recovery_authorizations SET status = 'expired' WHERE id = $1`,
          [authorizationId]
        );
        res.statusCode = 409;
        res.end(JSON.stringify({ ok: false, error: "authorization_expired" }));
        return;
      }

      const verification = verifyOwnerAuthorization(
        authorization.message,
        signature,
        authorization.owner_address
      );

      if (!verification.valid) {
        res.statusCode = 401;
        res.end(JSON.stringify({
          ok: false,
          error: "owner_signature_invalid",
          recoveredAddress: verification.recoveredAddress
        }));
        return;
      }

      await queryDatabase("BEGIN");
      try {
        await queryDatabase(`
          UPDATE recovery_authorizations
          SET signature = $2,
              status = 'authorized',
              authorized_at = NOW()
          WHERE id = $1
        `, [authorizationId, signature]);

        await queryDatabase(`
          UPDATE investigation_cases
          SET ownership_status = 'verified',
              recovery_status = 'authorized_pending_execution',
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object(
                  'ownerAuthorizationId', $2,
                  'ownerAuthorizationStatus', 'authorized',
                  'ownerAuthorizationAddress', $3,
                  'ownerAuthorizationDestination', $4,
                  'ownerAuthorizationVerifiedAt', NOW()
                ),
              updated_at = NOW()
          WHERE id = $1
        `, [
          authorization.case_id,
          authorizationId,
          verification.recoveredAddress.toLowerCase(),
          authorization.destination.toLowerCase()
        ]);

        await queryDatabase(`
          UPDATE recovery_events
          SET status = 'authorized_pending_execution',
              reason = 'owner_authorization_verified',
              updated_at = NOW()
          WHERE case_id = $1
            AND status IN ('blocked', 'pending', 'authorized_pending_execution')
        `, [authorization.case_id]);

        await queryDatabase("COMMIT");
      } catch (error) {
        await queryDatabase("ROLLBACK");
        throw error;
      }

      res.end(JSON.stringify({
        ok: true,
        authorizationId,
        status: "authorized",
        recoveredAddress: verification.recoveredAddress,
        execution: "disabled_until_external_signer_submission"
      }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: error.message || "authorization_failed" }));
    }
    return;
  }

  if (pathname === "/api/recovery/authorizations" && req.method === "GET") {
    try {
      const result = await queryDatabase(`
        SELECT id, case_id, owner_address, destination, nonce, status, expires_at, created_at, authorized_at
        FROM recovery_authorizations
        ORDER BY id DESC
        LIMIT 100
      `);
      res.end(JSON.stringify({ ok: true, authorizations: result.rows }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: "database_unavailable" }));
    }
    return;
  }

  if (pathname === "/api/recovery/summary") {
    try {
      const result = await queryDatabase(`
        SELECT
          COUNT(*) FILTER (WHERE recovery_status = 'not_authorized') AS blocked_cases,
          COUNT(*) FILTER (WHERE recovery_status = 'authorized_pending_execution') AS authorized_cases,
          COALESCE(SUM(CASE WHEN metadata->>'asset' = 'ETH' THEN 1 ELSE 0 END), 0) AS eth_cases
        FROM investigation_cases
      `);
      const events = await queryDatabase(`
        SELECT
          COUNT(*) AS executions,
          COALESCE(SUM(NULLIF(amount,'')::numeric),0) AS recovered_amount,
          COALESCE(SUM(NULLIF(gas_amount,'')::numeric),0) AS gas_amount,
          COALESCE(SUM(NULLIF(net_amount,'')::numeric),0) AS net_amount
        FROM recovery_events
        WHERE status = 'completed'
      `);
      res.end(JSON.stringify({ok:true,cases:result.rows[0],recoveries:events.rows[0]}));
    } catch {
      res.statusCode=503;
      res.end(JSON.stringify({ok:false,error:"database_unavailable"}));
    }
    return;
  }

  if (pathname === "/api/recovery/events") {
    try {
      const result = await queryDatabase(`
        SELECT id, chain, case_id, tx_hash, asset, amount, gas_amount, net_amount,
               destination, status, reason, created_at
        FROM recovery_events
        ORDER BY id DESC
        LIMIT 100
      `);
      res.end(JSON.stringify({ok:true,events:result.rows}));
    } catch {
      res.statusCode=503;
      res.end(JSON.stringify({ok:false,error:"database_unavailable"}));
    }
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
        SELECT id, chain, tx_hash, block_number, confidence, ownership_status, recovery_status,
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

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "internal_error" }));
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ledger-audit listening on 0.0.0.0:${port}`);
  startScanner();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (scannerRestartTimer) {
    clearTimeout(scannerRestartTimer);
    scannerRestartTimer = null;
  }
  if (scannerProcess && !scannerProcess.killed) scannerProcess.kill("SIGTERM");
  server.close(() => pool.end().finally(() => process.exit(0)));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
