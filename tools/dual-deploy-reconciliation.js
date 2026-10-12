import { calculateOperationOwnedAmounts } from "./dual-deploy.js";

export function walletDlmmPositionAddresses(scanResult) {
  if (!(scanResult instanceof Map)) throw new Error("Wallet-wide DLMM position scan returned an unknown response shape");
  return [...scanResult.values()].flatMap((entry) => {
    if (!Array.isArray(entry?.lbPairPositionsData)) throw new Error("Wallet-wide DLMM position scan has an unknown response shape");
    return entry.lbPairPositionsData.map((position) => {
      if (!position?.publicKey) throw new Error("Wallet-wide DLMM position scan omitted a position address");
      return position.publicKey.toString();
    });
  });
}

export async function reconcileExternallySettledDualDeploy({
  journal,
  operation,
  solMint,
  readPositionAccount,
  readMintInventory,
  readSignatureStatus,
  readBlockHeight,
  listWalletPositions,
}) {
  if (operation.kind === "exit" || ["completed", "cancelled"].includes(operation.stage)) return null;
  const transactions = operation.transactions || [];
  if (transactions.some((tx) => !["confirmed", "failed", "expired"].includes(tx.status))) return null;
  const owned = calculateOperationOwnedAmounts(transactions);
  if (!owned.complete) return null;
  const assets = [
    { mint: operation.plan?.token_x_mint, amountRaw: owned.x },
    { mint: operation.plan?.token_y_mint, amountRaw: owned.y },
  ].filter((asset) => asset.mint && asset.mint !== solMint && BigInt(asset.amountRaw) > 0n);
  if (assets.length === 0) return null;

  if (operation.positionSignature) {
    const lastValidBlockHeight = Number(operation.lastValidBlockHeight);
    if (!Number.isInteger(lastValidBlockHeight) || await readBlockHeight() <= lastValidBlockHeight) return null;
    const status = await readSignatureStatus(operation.positionSignature);
    if (status && status.confirmationStatus !== "finalized") return null;
  }
  for (const tx of transactions.filter((entry) => entry.status === "confirmed")) {
    const status = await readSignatureStatus(tx.signature);
    if (status?.confirmationStatus !== "finalized" || status.err) return null;
  }
  if (operation.positionAddress && await readPositionAccount(operation.positionAddress)) return null;

  const balances = {};
  for (const asset of assets) {
    const inventory = await readMintInventory(operation.walletAddress, asset.mint);
    balances[asset.mint] = String(inventory.totalRaw);
    if (BigInt(inventory.totalRaw) !== 0n) return null;
  }

  const positions = await listWalletPositions(operation.walletAddress);
  if (!Array.isArray(positions)) throw new Error("Wallet-wide DLMM position scan did not return a list");
  if (positions.length > 0) return null;

  return journal.transition(operation.id, "cancelled", {
    ...(operation.recoveryError ? { reconciledError: operation.recoveryError, recoveryError: null } : {}),
    externalSettlement: {
      verifiedAt: new Date().toISOString(),
      evidence: "finalized_swap_wallet_tokens_zero_and_wallet_dlmm_positions_absent",
      walletTokenBalancesRaw: balances,
      walletDlmmPositions: [],
      solProceedsVerified: false,
      pnlVerified: false,
    },
    cancelledAt: new Date().toISOString(),
  });
}
