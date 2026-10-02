import { rpcCall } from "../indexer/rpcClient.js";

const SELECTORS = {
  owner: "0x8da5cb5b",
  admin: "0xf851a440",
  pendingOwner: "0xe30c3978",
  withdraw: "0x3cc50b45",
  withdrawUint: "0x2e1a7d4d"
};

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function decodeAddress(result) {
  if (!result || typeof result !== "string" || result.length < 66) return null;
  return "0x" + result.slice(-40);
}

async function ethCall(rpcUrl, to, data) {
  try {
    return await rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"]);
  } catch {
    return null;
  }
}

export async function inspectContract(rpcUrl, address) {
  if (!isAddress(address)) return null;

  const [code, balance] = await Promise.all([
    rpcCall(rpcUrl, "eth_getCode", [address, "latest"]),
    rpcCall(rpcUrl, "eth_getBalance", [address, "latest"])
  ]);

  if (!code || code === "0x") return null;

  const signals = [];
  const owner = decodeAddress(await ethCall(rpcUrl, address, SELECTORS.owner));
  const admin = decodeAddress(await ethCall(rpcUrl, address, SELECTORS.admin));
  const pendingOwner = decodeAddress(await ethCall(rpcUrl, address, SELECTORS.pendingOwner));

  if (owner) signals.push("owner()");
  if (admin) signals.push("admin()");
  if (pendingOwner) signals.push("pendingOwner()");

  const methodSignals = [];
  for (const [name, selector] of Object.entries({
    withdraw: SELECTORS.withdraw,
    withdrawUint: SELECTORS.withdrawUint
  })) {
    const result = await ethCall(rpcUrl, address, selector);
    if (result !== null) methodSignals.push(name);
  }

  let balanceWei = "0";
  try { balanceWei = BigInt(balance || "0x0").toString(); } catch {}

  return {
    address,
    isContract: true,
    ethBalanceWei: balanceWei,
    codeSizeBytes: Math.max(0, (code.length - 2) / 2),
    owner,
    admin,
    pendingOwner,
    signals,
    methodSignals,
    potential: BigInt(balance || "0x0") > 0n || signals.length > 0 || methodSignals.length > 0,
    evidence: [
      ...(BigInt(balance || "0x0") > 0n ? ["contract_has_eth_balance"] : []),
      ...signals.map(x => `callable_${x}`),
      ...methodSignals.map(x => `callable_${x}`)
    ]
  };
}

export async function scanContracts(rpcUrl, transactions = [], maxContracts = 50) {
  const addresses = new Set();
  for (const tx of transactions) {
    if (isAddress(tx.to)) addresses.add(tx.to.toLowerCase());
    for (const transfer of tx.tokenTransfers || []) {
      if (isAddress(transfer.tokenContract)) addresses.add(transfer.tokenContract.toLowerCase());
    }
    if (addresses.size >= maxContracts) break;
  }

  const results = [];
  for (const address of addresses) {
    const result = await inspectContract(rpcUrl, address);
    if (result) results.push(result);
  }
  return results;
}
