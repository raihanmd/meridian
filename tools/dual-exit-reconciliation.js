export async function reconcileExternallySettledDualExit({
  journal,
  operation,
  readPositionAccount,
  readMintBalance,
}) {
  if (operation.kind !== "exit" || ["completed", "cancelled"].includes(operation.stage)) return null;
  const remaining = Object.values(operation.assetsRemaining || {})
    .filter((asset) => BigInt(asset.amount_raw || "0") > 0n);
  if (remaining.length === 0 || (operation.transactions || []).some((tx) => !["failed", "expired"].includes(tx.status))) return null;

  const positionAccount = await readPositionAccount(operation.positionAddress);
  if (positionAccount) return null;

  const balances = {};
  for (const asset of remaining) {
    const balance = BigInt(await readMintBalance(operation.walletAddress, asset.mint));
    balances[asset.mint] = balance.toString();
    if (balance !== 0n) return null;
  }

  const assetsRemaining = Object.fromEntries(Object.entries(operation.assetsRemaining).map(([mint, asset]) => [
    mint, { ...asset, amount_raw: "0" },
  ]));
  return journal.transition(operation.id, "completed", {
    assetsRemaining,
    externalSettlement: {
      verifiedAt: new Date().toISOString(),
      evidence: "position_account_absent_and_wallet_token_balances_zero",
      walletTokenBalancesRaw: balances,
      solProceedsVerified: false,
    },
    completedAt: new Date().toISOString(),
  });
}
