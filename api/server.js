import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pool } from "../database/connection.js";
import { rpcCall } from "../indexer/rpcClient.js";
import { ethers } from "ethers";
import {
  buildOwnerAuthorizationMessage,
  verifyOwnerAuthorization
} from "../recovery/ownerAuthorization.js";

// RUNTIME_BUILD_MARKER: authorization-backfill-syntax-fixed-2026-10-02

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
  ALTER TABLE recovery_authorizations
    ADD COLUMN IF NOT EXISTS transaction_hash TEXT;
  ALTER TABLE recovery_authorizations
    ADD COLUMN IF NOT EXISTS transaction_chain_id TEXT;
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

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function normalizeAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""))
    ? String(value).toLowerCase()
    : null;
}

function safeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

async function backfillOpportunityAuthorizationRequests() {
  const destination = normalizeAddress(process.env.AUTHORIZED_DESTINATION_ADDRESS);
  if (!destination) {
    console.warn("[AUTHORIZATION_BACKFILL] skipped: AUTHORIZED_DESTINATION_ADDRESS not configured");
    return;
  }

  const result = await queryDatabase(`
    SELECT ic.id, ic.chain, ic.tx_hash AS hash, ic.metadata, t.from_address
    FROM investigation_cases ic
    LEFT JOIN transactions t ON t.tx_hash = ic.tx_hash
    WHERE (
      ic.findings @> '[{"type":"possible_lost_funds"}]'::jsonb
      OR ic.confidence = 'high'
    )
    ORDER BY ic.id DESC
    LIMIT 500
  `);

  let created = 0;
  let skippedWithoutOwner = 0;
  let skippedExisting = 0;
  for (const row of result.rows) {
    // O from_address é apenas um candidato técnico para contato/autorização.
    // Ele não é tratado como prova de propriedade.
    const currentMetadata = safeMetadata(row.metadata);
    if (!currentMetadata.ownerCandidateAddress && normalizeAddress(row.from_address)) {
      await queryDatabase(`
        UPDATE investigation_cases
        SET metadata = $1::jsonb, updated_at = NOW()
        WHERE id = $2
      `, [JSON.stringify({
        ...currentMetadata,
        ownerCandidateAddress: normalizeAddress(row.from_address)
      }), row.id]);
      row.metadata = {
        ...currentMetadata,
        ownerCandidateAddress: normalizeAddress(row.from_address)
      };
    }
    const metadata = safeMetadata(row.metadata);
    const ownerAddress = normalizeAddress(
      metadata.ownerCandidateAddress || row.from_address
    );
    if (!ownerAddress) {
      skippedWithoutOwner++;
      continue;
    }

    const existing = await queryDatabase(`
      SELECT id
      FROM recovery_authorizations
      WHERE case_id = $1
        AND status IN ('pending','authorized','submitted_pending_confirmation')
      LIMIT 1
    `, [row.id]);

    if (existing.rows.length) {
      skippedExisting++;
      continue;
    }

    const nonce = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    let amount = "a confirmar";
    try {
      if (metadata.amountWei) amount = ethers.formatEther(BigInt(metadata.amountWei));
    } catch {}

    const message = buildOwnerAuthorizationMessage({
      domain: "Ledger Audit",
      caseId: row.id,
      chain: row.chain,
      sourceAddress: ownerAddress,
      destination,
      amount,
      expiresAt: expiresAt.toISOString(),
      nonce
    });

    await queryDatabase(`
      INSERT INTO recovery_authorizations
        (case_id, owner_address, destination, nonce, message, status, expires_at)
      VALUES ($1,$2,$3,$4,$5,'pending',$6)
    `, [row.id, ownerAddress, destination, nonce, message, expiresAt]);

    created++;
  }

  const summary = {
    created,
    candidates: result.rows.length,
    skippedWithoutOwner,
    skippedExisting,
    destination
  };
  console.log("[AUTHORIZATION_BACKFILL]", JSON.stringify(summary));
  return summary;
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

  const authorizationPageMatch = pathname.match(/^\/recovery\/authorize\/(\d+)$/);
  if (authorizationPageMatch) {
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
      execution: "disabled_until_ownership_and_recovery_mechanism_are_verified",
    authorization: {
      enabled: true,
      method: "OWNER_SIGNED_MESSAGE",
      endpoint: "/api/recovery/authorize",
      page: "/recovery/authorize/:id"
    }
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
      const caseId = Number(body.case_id);
      const destination = normalizeAddress(
        body.destination || process.env.AUTHORIZED_DESTINATION_ADDRESS
      );

      if (!Number.isInteger(caseId) || caseId <= 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "invalid_case_id" }));
        return;
      }

      if (!destination) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          ok: false,
          error: "authorized_destination_not_configured"
        }));
        return;
      }

      const caseResult = await queryDatabase(`
        SELECT id, chain, hash, metadata, ownership_status, recovery_status
        FROM investigation_cases
        WHERE id = $1
        LIMIT 1
      `, [caseId]);

      const caseRow = caseResult.rows[0];

      if (!caseRow) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "case_not_found" }));
        return;
      }

      const metadata = safeMetadata(caseRow.metadata);

      const ownerAddress = normalizeAddress(
        metadata.ownerAddress ||
        metadata.owner_address ||
        metadata.ownerCandidateAddress ||
        metadata.owner_candidate_address ||
        metadata.recoveryAuthorityAddress ||
        metadata.recovery_authority_address
      );

      if (!ownerAddress) {
        res.statusCode = 409;
        res.end(JSON.stringify({
          ok: false,
          error: "owner_address_not_registered_in_case"
        }));
        return;
      }

      const expiresMinutes = Math.min(
        1440,
        Math.max(5, Number(process.env.RECOVERY_AUTHORIZATION_EXPIRY_MINUTES || 30))
      );
      const expiresAt = new Date(
        Date.now() + expiresMinutes * 60 * 1000
      ).toISOString();
      const nonce = randomBytes(24).toString("hex");

      const message = buildOwnerAuthorizationMessage({
        domain: process.env.RECOVERY_AUTHORIZATION_DOMAIN || "Ledger Audit",
        caseId: caseRow.id,
        chain: caseRow.chain || "unknown",
        sourceAddress:
          metadata.sourceAddress ||
          metadata.source_address ||
          metadata.ownerCandidateAddress ||
          metadata.owner_candidate_address ||
          metadata.recoverySourceAddress ||
          metadata.recovery_source_address ||
          "",
        destination,
        amount: (() => {
          const value = metadata.amount ?? metadata.value ?? metadata.recoveryAmount ?? metadata.recovery_amount;
          if (value !== undefined && value !== null && String(value).trim() !== "") return value;
          try {
            if (metadata.amountWei) return ethers.formatEther(BigInt(metadata.amountWei));
          } catch {}
          return "a confirmar";
        })(),
        expiresAt,
        nonce
      });

      const insert = await queryDatabase(`
        INSERT INTO recovery_authorizations
          (case_id, owner_address, destination, nonce, message, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6)
        RETURNING id, case_id, owner_address, destination, nonce,
                  message, status, expires_at, created_at
      `, [
        caseRow.id,
        ownerAddress,
        destination,
        nonce,
        message,
        expiresAt
      ]);

      const authorization = insert.rows[0];

      res.statusCode = 201;
      res.end(JSON.stringify({
        ok: true,
        authorization: {
          ...authorization,
          authorizationUrl: `/recovery/authorize/${authorization.id}`
        }
      }));
    } catch (error) {
      console.error("[AUTHORIZATION_CREATE]", error);
      res.statusCode = 500;
      res.end(JSON.stringify({
        ok: false,
        error: "authorization_create_failed"
      }));
    }
    return;
  }

  const authorizationMatch = pathname.match(
    /^\/api\/recovery\/authorization\/(\d+)$/
  );

  if (authorizationMatch && req.method === "GET") {
    try {
      const authorizationId = Number(authorizationMatch[1]);

      const result = await queryDatabase(`
        SELECT
          ra.id,
          ra.case_id,
          ra.owner_address,
          ra.destination,
          ra.nonce,
          ra.message,
          ra.status,
          ra.expires_at,
          ra.created_at,
          ra.authorized_at,
          ic.chain,
          ic.tx_hash AS tx_hash,
          ic.metadata
        FROM recovery_authorizations ra
        LEFT JOIN investigation_cases ic
          ON ic.id = ra.case_id
        WHERE ra.id = $1
        LIMIT 1
      `, [authorizationId]);

      const authorization = result.rows[0];

      if (!authorization) {
        res.statusCode = 404;
        res.end(JSON.stringify({
          ok: false,
          error: "authorization_not_found"
        }));
        return;
      }

      res.end(JSON.stringify({ ok: true, authorization }));
    } catch (error) {
      console.error("[AUTHORIZATION_GET]", error);
      res.statusCode = 503;
      res.end(JSON.stringify({
        ok: false,
        error: "database_unavailable"
      }));
    }
    return;
  }

  if (pathname === "/api/recovery/transaction-submitted" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const authorizationId = Number(body.authorization_id);
      const txHash = String(body.tx_hash || "").trim();
      const ownerAddress = normalizeAddress(body.owner_address);
      const chainId = String(body.chain_id || "").trim();

      if (!Number.isInteger(authorizationId) || authorizationId <= 0 || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok:false, error:"invalid_transaction_submission" }));
        return;
      }

      const result = await queryDatabase(`
        SELECT id, case_id, owner_address, destination, status, expires_at
        FROM recovery_authorizations
        WHERE id = $1
        LIMIT 1
      `, [authorizationId]);

      const authorization = result.rows[0];

      if (!authorization) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok:false, error:"authorization_not_found" }));
        return;
      }

      if (authorization.status !== "pending" && authorization.status !== "submitted_pending_confirmation") {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok:false, error:"authorization_not_pending", status:authorization.status }));
        return;
      }

      if (new Date(authorization.expires_at).getTime() <= Date.now()) {
        res.statusCode = 410;
        res.end(JSON.stringify({ ok:false, error:"authorization_expired" }));
        return;
      }

      if (!ownerAddress || ownerAddress !== String(authorization.owner_address).toLowerCase()) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok:false, error:"owner_address_mismatch" }));
        return;
      }

      const tx = await rpcCall(process.env.RPC_URL, "eth_getTransactionByHash", [txHash]);
      if (!tx) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok:false, error:"transaction_not_found_yet" }));
        return;
      }

      const from = normalizeAddress(tx.from);
      const to = normalizeAddress(tx.to);

      if (from !== String(authorization.owner_address).toLowerCase()) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok:false, error:"transaction_sender_mismatch" }));
        return;
      }

      if (to !== String(authorization.destination).toLowerCase()) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok:false, error:"transaction_destination_mismatch" }));
        return;
      }

      const caseResult = await queryDatabase(`
        SELECT id, chain, metadata
        FROM investigation_cases
        WHERE id = $1
        LIMIT 1
      `, [authorization.case_id]);

      const caseRow = caseResult.rows[0];
      if (!caseRow) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok:false, error:"case_not_found" }));
        return;
      }

      const metadata = safeMetadata(caseRow.metadata);
      const asset = String(metadata.asset || metadata.token || "ETH").toUpperCase();
      if (asset !== "ETH") {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok:false, error:"only_native_eth_supported_in_first_version" }));
        return;
      }

      const expectedAmount = metadata.amount ?? metadata.value ?? metadata.recoveryAmount;
      if (expectedAmount === undefined || expectedAmount === null || String(expectedAmount).trim() === "") {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok:false, error:"authorization_amount_missing" }));
        return;
      }

      let expectedWei;
      try {
        expectedWei = ethers.parseEther(String(expectedAmount).trim()).toString();
      } catch {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok:false, error:"invalid_authorization_amount" }));
        return;
      }

      const actualWei = BigInt(tx.value || "0x0").toString();
      if (actualWei !== expectedWei) {
        res.statusCode = 403;
        res.end(JSON.stringify({
          ok:false,
          error:"transaction_value_mismatch",
          expectedWei,
          actualWei
        }));
        return;
      }

      await queryDatabase(`
        UPDATE recovery_authorizations
        SET status = 'submitted_pending_confirmation',
            transaction_hash = $1,
            transaction_chain_id = $2
        WHERE id = $3
      `, [txHash, chainId || null, authorizationId]);

      res.end(JSON.stringify({
        ok:true,
        status:"submitted_pending_confirmation",
        transactionHash:txHash
      }));
    } catch (error) {
      console.error("[RECOVERY_TX_SUBMITTED]", error);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok:false, error:"transaction_validation_failed" }));
    }
    return;
  }

  if (pathname === "/api/recovery/transaction-status" && req.method === "GET") {
    try {
      const authorizationId = Number(requestUrl.searchParams.get("authorization_id"));

      if (!Number.isInteger(authorizationId) || authorizationId <= 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok:false, error:"invalid_authorization_id" }));
        return;
      }

      const result = await queryDatabase(`
        SELECT id, case_id, owner_address, destination, status,
               transaction_hash, transaction_chain_id
        FROM recovery_authorizations
        WHERE id = $1
        LIMIT 1
      `, [authorizationId]);

      const authorization = result.rows[0];
      if (!authorization) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok:false, error:"authorization_not_found" }));
        return;
      }

      if (!authorization.transaction_hash) {
        res.end(JSON.stringify({ ok:true, status:authorization.status }));
        return;
      }

      const receipt = await rpcCall(
        process.env.RPC_URL,
        "eth_getTransactionReceipt",
        [authorization.transaction_hash]
      );

      if (!receipt) {
        res.end(JSON.stringify({
          ok:true,
          status:"submitted_pending_confirmation",
          transactionHash:authorization.transaction_hash
        }));
        return;
      }

      if (receipt.status !== "0x1") {
        await queryDatabase(`
          UPDATE recovery_authorizations
          SET status = 'failed'
          WHERE id = $1
        `, [authorizationId]);

        res.end(JSON.stringify({
          ok:true,
          status:"failed",
          transactionHash:authorization.transaction_hash
        }));
        return;
      }

      const caseResult = await queryDatabase(`
        SELECT id, metadata
        FROM investigation_cases
        WHERE id = $1
        LIMIT 1
      `, [authorization.case_id]);

      const caseRow = caseResult.rows[0];
      const metadata = safeMetadata(caseRow?.metadata);

      const updatedMetadata = {
        ...metadata,
        ownerAddress: authorization.owner_address,
        ownerVerified: true,
        ownerAuthorizationId: authorization.id,
        ownerAuthorizationAt: new Date().toISOString(),
        recoveryAuthorityVerified: true,
        recoveryMechanismVerified: true,
        recoveryMechanismType: "OWNER_WALLET_TRANSACTION",
        recoveryAuthorizationVerified: true,
        recoveryAuthorizationDestination: authorization.destination,
        recoveryTransactionHash: authorization.transaction_hash
      };

      await queryDatabase(`
        UPDATE recovery_authorizations
        SET status = 'authorized',
            authorized_at = NOW()
        WHERE id = $1
      `, [authorizationId]);

      await queryDatabase(`
        UPDATE investigation_cases
        SET ownership_status = 'verified',
            recovery_status = 'authorized_pending_execution',
            metadata = $1::jsonb
        WHERE id = $2
      `, [JSON.stringify(updatedMetadata), authorization.case_id]);

      await queryDatabase(`
        UPDATE recovery_events
        SET status = 'completed',
            tx_hash = $1,
            destination = $2,
            reason = 'owner_approved_and_transaction_confirmed',
            updated_at = NOW()
        WHERE case_id = $3
          AND status IN ('blocked', 'pending', 'authorized_pending_execution')
      `, [authorization.transaction_hash, authorization.destination, authorization.case_id]);

      res.end(JSON.stringify({
        ok:true,
        status:"confirmed",
        transactionHash:authorization.transaction_hash,
        blockNumber:receipt.blockNumber
      }));
    } catch (error) {
      console.error("[RECOVERY_TX_STATUS]", error);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok:false, error:"transaction_status_failed" }));
    }
    return;
  }

  if (pathname === "/api/recovery/authorize" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const authorizationId = Number(body.authorization_id);
      const signature = String(body.signature || "").trim();
      const ownerAddress = normalizeAddress(body.owner_address);

      if (!Number.isInteger(authorizationId) || authorizationId <= 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          ok: false,
          error: "invalid_authorization_id"
        }));
        return;
      }

      if (!signature) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          ok: false,
          error: "signature_required"
        }));
        return;
      }

      const result = await queryDatabase(`
        SELECT id, case_id, owner_address, destination, nonce, message,
               status, expires_at
        FROM recovery_authorizations
        WHERE id = $1
        LIMIT 1
      `, [authorizationId]);

      const authorization = result.rows[0];

      if (!authorization) {
        res.statusCode = 404;
        res.end(JSON.stringify({
          ok: false,
          error: "authorization_not_found"
        }));
        return;
      }

      if (authorization.status !== "pending") {
        res.statusCode = 409;
        res.end(JSON.stringify({
          ok: false,
          error: "authorization_not_pending",
          status: authorization.status
        }));
        return;
      }

      if (new Date(authorization.expires_at).getTime() <= Date.now()) {
        await queryDatabase(`
          UPDATE recovery_authorizations
          SET status = 'expired'
          WHERE id = $1
        `, [authorizationId]);

        res.statusCode = 410;
        res.end(JSON.stringify({
          ok: false,
          error: "authorization_expired"
        }));
        return;
      }

      if (
        ownerAddress &&
        ownerAddress !== String(authorization.owner_address).toLowerCase()
      ) {
        res.statusCode = 403;
        res.end(JSON.stringify({
          ok: false,
          error: "owner_address_mismatch"
        }));
        return;
      }

      const verification = verifyOwnerAuthorization(
        authorization.message,
        signature,
        authorization.owner_address
      );

      if (!verification.valid) {
        res.statusCode = 403;
        res.end(JSON.stringify({
          ok: false,
          error: "invalid_owner_signature",
          recoveredAddress: verification.recoveredAddress
        }));
        return;
      }

      const caseResult = await queryDatabase(`
        SELECT id, metadata
        FROM investigation_cases
        WHERE id = $1
        LIMIT 1
      `, [authorization.case_id]);

      const caseRow = caseResult.rows[0];

      if (!caseRow) {
        res.statusCode = 404;
        res.end(JSON.stringify({
          ok: false,
          error: "case_not_found"
        }));
        return;
      }

      const metadata = safeMetadata(caseRow.metadata);

      const updatedMetadata = {
        ...metadata,
        ownerAddress: authorization.owner_address,
        ownerVerified: true,
        ownerAuthorizationId: authorization.id,
        ownerAuthorizationAt: new Date().toISOString(),
        recoveryAuthorityVerified: true,
        recoveryMechanismVerified: true,
        recoveryMechanismType: "OWNER_SIGNED_AUTHORIZATION",
        recoveryAuthorizationVerified: true,
        recoveryAuthorizationDestination: authorization.destination
      };

      await queryDatabase(`
        UPDATE recovery_authorizations
        SET signature = $1,
            status = 'authorized',
            authorized_at = NOW()
        WHERE id = $2
      `, [signature, authorizationId]);

      await queryDatabase(`
        UPDATE investigation_cases
        SET ownership_status = 'verified',
            recovery_status = 'authorized_pending_execution',
            metadata = $1::jsonb
        WHERE id = $2
      `, [JSON.stringify(updatedMetadata), authorization.case_id]);

      await queryDatabase(`
        UPDATE recovery_events
        SET status = 'authorized_pending_execution',
            reason = 'owner_authorization_verified'
        WHERE case_id = $1
          AND status IN ('blocked', 'pending', 'authorized_pending_execution')
      `, [authorization.case_id]);

      res.end(JSON.stringify({
        ok: true,
        status: "authorized",
        authorization: {
          id: authorization.id,
          caseId: authorization.case_id,
          ownerAddress: authorization.owner_address,
          destination: authorization.destination,
          authorizedAt: new Date().toISOString()
        },
        recovery: {
          status: "authorized_pending_execution",
          execution: "disabled_until_external_signer_submission"
        }
      }));
    } catch (error) {
      console.error("[AUTHORIZATION_VERIFY]", error);
      res.statusCode = 500;
      res.end(JSON.stringify({
        ok: false,
        error: "authorization_verification_failed"
      }));
    }
    return;
  }

  if (pathname === "/api/recovery/authorizations/backfill" && req.method === "POST") {
    try {
      const result = await backfillOpportunityAuthorizationRequests();
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      console.error("[AUTHORIZATION_BACKFILL_API]", error);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: "authorization_backfill_failed" }));
    }
    return;
  }

  if (pathname === "/api/recovery/authorizations") {
    try {
      const limit = Math.min(
        200,
        Math.max(1, Number(requestUrl.searchParams.get("limit") || 100))
      );

      const result = await queryDatabase(`
        SELECT
          ra.id,
          ra.case_id,
          ra.owner_address,
          ra.destination,
          ra.nonce,
          ra.status,
          ra.expires_at,
          ra.created_at,
          ra.authorized_at,
          ra.transaction_hash,
          ra.transaction_chain_id,
          ic.hash AS tx_hash,
          ic.chain,
          ic.recovery_status
        FROM recovery_authorizations ra
        LEFT JOIN investigation_cases ic
          ON ic.id = ra.case_id
        ORDER BY ra.id DESC
        LIMIT $1
      `, [limit]);

      res.end(JSON.stringify({
        ok: true,
        authorizations: result.rows
      }));
    } catch (error) {
      console.error("[AUTHORIZATIONS_LIST]", error);
      res.statusCode = 503;
      res.end(JSON.stringify({
        ok: false,
        error: "database_unavailable"
      }));
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
  void backfillOpportunityAuthorizationRequests().catch(error => {
    console.error("[AUTHORIZATION_BACKFILL]", error.message);
  });
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
