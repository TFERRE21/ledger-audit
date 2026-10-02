import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import solc from "solc";

const rpcUrl = process.env.RECOVERY_REGISTRY_RPC_URL || process.env.RPC_URL;
const operatorKey = process.env.RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY;
const expectedChainId = 1n; // Ethereum Mainnet

if (!rpcUrl || !operatorKey) {
  throw new Error("Set RECOVERY_REGISTRY_RPC_URL/RPC_URL and RECOVERY_REGISTRY_OPERATOR_PRIVATE_KEY");
}

const source = await readFile(new URL("../contracts/RecoveryRequestRegistry.sol", import.meta.url), "utf8");

const input = {
  language: "Solidity",
  sources: { "RecoveryRequestRegistry.sol": { content: source } },
  settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter(e => e.severity === "error");
if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join("\n"));

const compiled = output.contracts["RecoveryRequestRegistry.sol"]["RecoveryRequestRegistry"];
const provider = new ethers.JsonRpcProvider(rpcUrl);
const wallet = new ethers.Wallet(operatorKey, provider);
const network = await provider.getNetwork();
if (network.chainId !== expectedChainId) {
  throw new Error(`Wrong network: expected Ethereum Mainnet (1), got ${network.chainId}`);
}
const factory = new ethers.ContractFactory(compiled.abi, compiled.evm.bytecode.object, wallet);
const contract = await factory.deploy(wallet.address);
await contract.waitForDeployment();

console.log(JSON.stringify({
  address: await contract.getAddress(),
  operator: wallet.address,
  network: "Ethereum Mainnet",
  chainId: "1",
  deploymentTx: contract.deploymentTransaction()?.hash
}, null, 2));
