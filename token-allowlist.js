import { PublicKey } from "@solana/web3.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export function normalizeTokenAllowlist(value) {
  if (!Array.isArray(value)) {
    throw new Error("tokenAllowlist must be an array of { name, mint } objects");
  }
  return value.map((entry, index) => {
    const name = entry?.name;
    const mint = entry?.mint;
    if (typeof name !== "string" || !name.trim() || typeof mint !== "string") {
      throw new Error(`tokenAllowlist[${index}] must contain a name and mint`);
    }
    try {
      if (new PublicKey(mint).toBase58() !== mint) throw new Error("noncanonical mint");
    } catch {
      throw new Error(`tokenAllowlist[${index}] has an invalid mint`);
    }
    return { name: name.trim(), mint };
  });
}

export function getPoolRestrictionReason(baseMint, quoteMint, allowlist) {
  if (!baseMint || !quoteMint) return "pool token mints are missing";
  if (quoteMint !== SOL_MINT) return "token Y must be SOL for single-sided SOL deploys";
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return "tokenAllowlist is empty; no token is approved for deployment";
  }
  const allowed = new Set(allowlist.map((entry) => entry.mint));
  if (!allowed.has(baseMint) || !allowed.has(quoteMint)) {
    return "both pool token mints must be in tokenAllowlist";
  }
  return null;
}

export function getDualPoolRestrictionReason(mintX, mintY, allowlist, baseMints = [SOL_MINT]) {
  if (!mintX || !mintY) return "pool token mints are missing";
  if (mintX === mintY) return "pool token mints must be different";
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return "tokenAllowlist is empty; add at least one approved non-base token";
  }
  const approved = new Set(allowlist.map((entry) => entry?.mint).filter(Boolean));
  const bases = new Set(baseMints.filter(Boolean));
  const unapproved = [mintX, mintY].filter((mint) => !bases.has(mint) && !approved.has(mint));
  if (unapproved.length) return "every non-base pool token must be in tokenAllowlist";
  if (![mintX, mintY].some((mint) => !bases.has(mint))) return "pool must contain at least one allowlisted non-base token";
  return null;
}

export function getPoolAllowlistDisplay(baseMint, quoteMint, allowlist) {
  const baseAllowlisted = Array.isArray(allowlist) && allowlist.some((entry) => entry.mint === baseMint);
  const restriction = getPoolRestrictionReason(baseMint, quoteMint, allowlist);
  return {
    baseAllowlisted,
    deployable: restriction === null,
    restriction,
    label: restriction === null ? "✅ ALLOWLIST · SOL PAIR"
      : baseAllowlisted ? "✅ TOKEN ALLOWLIST · 👀 OBSERVE"
      : "👀 OBSERVE",
  };
}
