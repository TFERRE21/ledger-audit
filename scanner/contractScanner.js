import { rpcCall } from "../indexer/rpcClient.js";

const STORAGE_SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
};

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

function encodeAddress(address) { return address.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }

async function ethCall(rpcUrl, to, data) {
  try {
    return await rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"]);
  } catch {
    return null;
  }
}

export async function inspectContract(rpcUrl, address) {
  if (!isAddress(address)) return null;

  const [code, balance, implementationSlot, adminSlot, beaconSlot] = await Promise.all([
    rpcCall(rpcUrl, "eth_getCode", [address, "latest"]),
    rpcCall(rpcUrl, "eth_getBalance", [address, "latest"]),
    rpcCall(rpcUrl, "eth_getStorageAt", [address, STORAGE_SLOTS.implementation, "latest"]),
    rpcCall(rpcUrl, "eth_getStorageAt", [address, STORAGE_SLOTS.admin, "latest"]),
    rpcCall(rpcUrl, "eth_getStorageAt", [address, STORAGE_SLOTS.beacon, "latest"])
  ]);

  if (!code || code === "0x") return null;

  const signals = [];
  const implementation = decodeAddress(implementationSlot);
  const proxyAdmin = decodeAddress(adminSlot);
  const beacon = decodeAddress(beaconSlot);
  if (implementation) signals.push("EIP-1967 implementation slot");
  if (proxyAdmin) signals.push("EIP-1967 admin slot");
  if (beacon) signals.push("EIP-1967 beacon slot");
  const proxyConfirmed = Boolean(implementation || beacon || proxyAdmin);
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

  const hasBalance = BigInt(balance || "0x0") > 0n;
  const hasAccessControl = Boolean(owner || admin || pendingOwner);
  const triageStatus = proxyConfirmed
    ? "PROXY_CONFIRMED"
    : hasAccessControl
      ? "ACCESS_CONTROL_DETECTED"
      : methodSignals.length
        ? "METHOD_DETECTED"
        : hasBalance
          ? "BALANCE_DETECTED"
          : "CODE_DETECTED";

  return {
    address,
    isContract: true,
    ethBalanceWei: balanceWei,
    codeSizeBytes: Math.max(0, (code.length - 2) / 2),
    owner,
    admin: admin || proxyAdmin,
    proxyAdmin,
    implementation,
    beacon,
    pendingOwner,
    proxyConfirmed,
    triageStatus,
    signals,
    methodSignals,
    potential: hasBalance || proxyConfirmed || hasAccessControl || methodSignals.length > 0,
    evidence: [
      ...(hasBalance ? ["contract_has_eth_balance"] : []),
      ...(proxyConfirmed ? ["proxy_confirmed"] : []),
      ...signals.map(x => `callable_${x}`),
      ...methodSignals.map(x => `callable_${x}`)
    ]
  };
}

export async function scanContracts(rpcUrl, transactions = [], maxContracts = 50) {
  const addresses = new Set();
  const tokenPairs = new Map();
  for (const tx of transactions) {
    if (isAddress(tx.to)) addresses.add(tx.to.toLowerCase());
    for (const transfer of tx.tokenTransfers || []) {
      if (isAddress(transfer.tokenContract)) {
        addresses.add(transfer.tokenContract.toLowerCase());
        if (isAddress(transfer.to)) {
          const key = `${transfer.tokenContract.toLowerCase()}:${transfer.to.toLowerCase()}`;
          tokenPairs.set(key, { tokenContract: transfer.tokenContract.toLowerCase(), holder: transfer.to.toLowerCase() });
        }
      }
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
