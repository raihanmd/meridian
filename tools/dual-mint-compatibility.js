import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

/** Match the token-program guard in the dual-token transaction path. */
export async function checkDualMintPrograms({ connection, mints, solMint }) {
  const uniqueMints = [...new Set(mints.filter((mint) => mint !== solMint))];
  const reasons = new Map();
  const addresses = [];
  for (const mint of uniqueMints) {
    try {
      addresses.push({ mint, address: new PublicKey(mint) });
    } catch {
      reasons.set(mint, "invalid token mint address");
    }
  }
  if (addresses.length === 0) return reasons;

  let accounts;
  try {
    accounts = await connection.getMultipleAccountsInfo(addresses.map((entry) => entry.address), "confirmed");
    if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
      throw new Error("incomplete mint account response");
    }
  } catch (error) {
    for (const { mint } of addresses) reasons.set(mint, `mint program verification unavailable: ${error.message}`);
    return reasons;
  }

  for (let i = 0; i < addresses.length; i++) {
    const { mint } = addresses[i];
    const account = accounts[i];
    const owner = account?.owner?.toString();
    if (!account) {
      reasons.set(mint, "mint account not found on chain");
    } else if (owner === TOKEN_2022_PROGRAM_ID.toString()) {
      reasons.set(mint, "Token-2022 mint is not yet supported by dual-token deployment");
    } else if (owner !== TOKEN_PROGRAM_ID.toString()) {
      reasons.set(mint, `mint owner ${owner || "unknown"} is not the supported SPL Token program`);
    }
  }
  return reasons;
}
