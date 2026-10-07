import { getScanConfig } from "./config.js";
import { getLatestBlock, scanRange } from "./rangeScanner.js";
import { investigateTransaction } from "../analyzers/caseEngine.js";
import { saveTransaction, saveCase, getScanProgress, setScanProgress, saveScanLog, saveContractFinding } from "../database/repository.js";
import { pool } from "../database/connection.js";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { buildOwnerAuthorizationMessage } from "../recovery/ownerAuthorization.js";
import { createOnChainRecoveryRequest, isRecoveryRegistryConfigured } from "../blockchain/recoveryRegistry.js";
import { rpcCall } from "../indexer/rpcClient.js";

import { scanContracts } from "./contractScanner.js";

const config = getScanConfig();

if (!config.rpcUrl) {
  console.error("RPC_URL is required");
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MIN_OWNER_BALANCE_WEI = 1000000000000000000n;

async function hasMinimumOwnerBalance(address) {
  try {
    const balanceHex = await rpcCall(config.rpcUrl, "eth_getBalance", [address, "latest"]);
    const balanceWei = BigInt(balanceHex || "0x0");
    return { eligible: balanceWei >= MIN_OWNER_BALANCE_WEI, balanceWei };
  } catch (error) {
    console.error(`[AUTHORIZATION_BALANCE] owner=${address} check failed: ${error.message}`);
    return { eligible: false, balanceWei: 0n, error: error.message };
  }
}

async function scanOnce() {
  let fromBlock = config.fromBlock;
  let toBlock = config.toBlock;
  let historical = false;

  if (config.historicalScan && config.fromBlock === 0 && config.toBlock === 0) {
    const latestBlock = await getLatestBlock(config.rpcUrl);
    fromBlock = await getScanProgress(config.chain, config.historicalStartBlock);

    if (fromBlock <= latestBlock) {
      toBlock = Math.min(fromBlock + config.historicalBatchBlocks - 1, latestBlock);
      historical = true;
    } else {
      fromBlock = Math.max(0, latestBlock - 4);
      toBlock = latestBlock;
    }
  } else if (fromBlock === 0 && toBlock === 0) {
    toBlock = await getLatestBlock(config.rpcUrl);
    fromBlock = Math.max(0, toBlock - 4);
  }

  if (toBlock < fromBlock) throw new Error("invalid scan range");

  await setScanProgress(config.chain, fromBlock, {
    currentBlock: fromBlock,
    status: historical ? "scanning_historical" : "scanning_live",
    batchTransactions: 0,
    batchCases: 0
  });

  const scanStartedAt = Date.now();
  console.log(
    `[SCAN] ${historical ? "HISTORICAL" : "LIVE"} blocks=${fromBlock}-${toBlock} ` +
    `blockConcurrency=${config.blockConcurrency}`
  );

  const transactions = await scanRange({
    ...config,
    fromBlock,
    toBlock,
    onProgress: async progress => {
      const elapsedSeconds = Math.max(0.001, (Date.now() - scanStartedAt) / 1000);
      const speed = progress.scannedBlocks / elapsedSeconds;
      const remainingBlocks = Math.max(0, progress.totalBlocks - progress.scannedBlocks);
      const etaSeconds = speed > 0 ? remainingBlocks / speed : null;
      const logLine = `[SCAN] progress block=${progress.currentBlock} blocks=${progress.scannedBlocks}/${progress.totalBlocks} tx=${progress.transactions}`;

      await setScanProgress(config.chain, progress.currentBlock + 1, {
        currentBlock: progress.currentBlock,
        status: historical ? "scanning_historical" : "scanning_live",
        batchTransactions: progress.transactions,
        batchCases: 0,
        speedBlocksPerSecond: speed,
        etaSeconds,
        logLine
      });

      console.log(logLine);
      await saveScanLog({ chain: config.chain, blockNumber: progress.currentBlock, message: logLine });
    }
  });

  let savedTransactions = 0;
  let savedCases = 0;
  let recoveryCandidates = 0;

  for (const tx of transactions) {
    await saveTransaction(tx);
    savedTransactions++;

    const caseData = investigateTransaction({
      ...tx,
      authorizedDestination: config.authorizedDestination
    });

    if (caseData.findings.length > 0) {
      const caseId = await saveCase(caseData);
      savedCases++;

      // Toda oportunidade com um endereço candidato de controle gera automaticamente
      // uma solicitação individual de aprovação. Isso não presume propriedade: a carteira
      // precisa assinar a solicitação para comprovar controle do endereço candidato.
      const ownerCandidate = String(caseData.metadata?.ownerCandidateAddress || "").toLowerCase();
      const destination = config.authorizedDestination;
      if (
        /^0x[a-f-f0-9]{40}$/i.test(ownerCandidate) &&
        /^0x[a-f-f0-9]{40}$/i.test(String(destination || ""))
      ) {
        const balanceCheck = await hasMinimumOwnerBalance(ownerCandidate);
        if (!balanceCheck.eligible) {
          await saveScanLog({
            chain: config.chain,
            blockNumber: tx.blockNumber,
            level: "authorization_skipped",
            message: `[AUTHORIZATION_SKIPPED] case=${caseId} ownerCandidate=${ownerCandidate} balanceWei=${balanceCheck.balanceWei.toString()} reason=balance_below_1_eth`,
            opportunity: false
          });
          console.log(`[AUTHORIZATION_SKIPPED] case=${caseId} ownerCandidate=${ownerCandidate} reason=balance_below_1_eth`);
          continue;
        }

        const existing = await pool.query(
          `SELECT id FROM recovery_authorizations
           WHERE case_id = $1
             AND status IN ('pending','authorized','submitted_pending_confirmation')
           ORDER BY id DESC LIMIT 1`,
          [caseId]
        );

        if (!existing.rows.length) {
          const nonce = randomBytes(24).toString("hex");
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
          let amount = "a confirmar";
          try {
            if (caseData.metadata?.amountWei) {
              amount = ethers.formatEther(BigInt(caseData.metadata.amountWei));
            }
          } catch {}

          const message = buildOwnerAuthorizationMessage({
            domain: "Ledger Audit",
            caseId,
            chain: caseData.chain,
            sourceAddress: ownerCandidate,
            destination,
            amount,
            expiresAt: expiresAt.toISOString(),
            nonce
          });

          await pool.query(
            `INSERT INTO recovery_authorizations
              (case_id, owner_address, destination, nonce, message, status, expires_at)
             VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
            [caseId, ownerCandidate, String(destination).toLowerCase(), nonce, message, expiresAt]
          );

          if (isRecoveryRegistryConfigured()) {
            try {
              let amountWei = "0";
              if (caseData.metadata?.amountWei) {
                amountWei = BigInt(caseData.metadata.amountWei).toString();
              } else if (amount !== "a confirmar") {
                amountWei = ethers.parseEther(String(amount)).toString();
              }

              const onChain = await createOnChainRecoveryRequest({
                owner: ownerCandidate,
                caseId,
                chainId: Number(process.env.RECOVERY_REGISTRY_CHAIN_ID || 1),
                amountWei,
                destination: String(destination).toLowerCase(),
                expiresAt
              });

              await pool.query(
                `UPDATE recovery_authorizations
                 SET onchain_request_id = $1, onchain_tx_hash = $2
                 WHERE case_id = $3 AND owner_address = $4 AND status = 'pending'`,
                [onChain.requestId, onChain.txHash, caseId, ownerCandidate]
              );

              console.log(`[AUTHORIZATION_ONCHAIN] case=${caseId} request=${onChain.requestId} tx=${onChain.txHash}`);
            } catch (error) {
              console.error(`[AUTHORIZATION_ONCHAIN] case=${caseId} failed`, error);
            }
          }

          await saveScanLog({
            chain: config.chain,
            blockNumber: tx.blockNumber,
            level: "authorization_request",
            message: `[AUTHORIZATION_REQUEST] case=${caseId} ownerCandidate=${ownerCandidate} destination=${destination} status=pending`,
            opportunity: true
          });
          console.log(`[AUTHORIZATION_REQUEST] case=${caseId} ownerCandidate=${ownerCandidate} status=pending`);
        }
      }

      if (caseData.recoveryEligible) {
        recoveryCandidates++;
        const opportunityLog = `[OPPORTUNITY] tx=${caseData.hash} confidence=${caseData.confidence} recovery=${caseData.recoveryStatus}`;
        await saveScanLog({ chain: config.chain, blockNumber: tx.blockNumber, level: "opportunity", message: opportunityLog, opportunity: true });
        console.log(opportunityLog);
        console.log(JSON.stringify({
          event: "RECOVERY_CANDIDATE",
          txHash: caseData.hash,
          chain: caseData.chain,
          recoveryStatus: caseData.recoveryStatus,
          mode: config.recoveryMode,
          destination: config.authorizedDestination || "NOT_CONFIGURED"
        }));
      }
    }
  }

  const contractFindings = await scanContracts(config.rpcUrl, transactions, config.contractScanLimit);
  let contractOpportunities = 0;
  for (const finding of contractFindings) {
    const normalized = { ...finding, chain: config.chain, blockNumber: toBlock };
    await saveContractFinding(normalized);
    if (finding.potential) {
      contractOpportunities++;
      const message = `[CONTRACT_OPPORTUNITY] address=${finding.address} ethBalanceWei=${finding.ethBalanceWei} owner=${finding.owner || "none"} admin=${finding.admin || "none"} signals=${[...(finding.signals||[]), ...(finding.methodSignals||[])].join(",") || "none"}`;
      await saveScanLog({ chain: config.chain, blockNumber: toBlock, level: "contract_opportunity", message, opportunity: true });
      console.log(message);
    }
  }

  if (config.historicalScan && historical) {
    await setScanProgress(config.chain, toBlock + 1, {
      currentBlock: toBlock,
      status: "batch_complete",
      batchTransactions: savedTransactions,
      batchCases: savedCases
    });
  } else {
    await setScanProgress(config.chain, toBlock, {
      currentBlock: toBlock,
      status: "live_complete",
      batchTransactions: savedTransactions,
      batchCases: savedCases
    });
  }

  console.log(JSON.stringify({
    chain: config.chain,
    mode: historical ? "historical" : "live",
    blocks: { from: fromBlock, to: toBlock },
    transactions: transactions.length,
    savedTransactions,
    savedCases,
    recoveryCandidates,
    contractFindings: contractFindings.length,
    contractOpportunities,
    recoveryMode: config.recoveryMode,
    authorizedDestinationConfigured: Boolean(config.authorizedDestination),
    nextHistoricalBlock: historical ? toBlock + 1 : null
  }, null, 2));

  return toBlock;
}

try {
  do {
    await scanOnce();

    if (!config.monitor) break;

    await sleep(config.intervalSeconds * 1000);
    config.fromBlock = 0;
    config.toBlock = 0;
  } while (true);
} finally {
  await pool.end();
}
