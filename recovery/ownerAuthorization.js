import { ethers } from "ethers";

export function buildOwnerAuthorizationMessage({
  domain,
  caseId,
  chain,
  sourceAddress,
  destination,
  amount,
  expiresAt,
  nonce
}) {
  return [
    `${domain} solicita autorização para recuperação de ativos:`,
    "",
    `Caso: ${caseId}`,
    `Rede: ${chain}`,
    `Origem: ${sourceAddress}`,
    `Destino autorizado: ${destination}`,
    `Valor: ${amount || "a confirmar"}`,
    `Nonce: ${nonce}`,
    `Expira em: ${expiresAt}`,
    "",
    "Eu autorizo explicitamente esta recuperação somente para o caso, origem e destino acima."
  ].join("\n");
}

export function verifyOwnerAuthorization(
  message,
  signature,
  expectedAddress
) {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);

    return {
      valid:
        recoveredAddress.toLowerCase() ===
        String(expectedAddress || "").toLowerCase(),
      recoveredAddress
    };
  } catch {
    return {
      valid: false,
      recoveredAddress: null
    };
  }
}
