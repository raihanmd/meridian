/**
 * Resume every non-terminal dual deploy for one wallet, independent of the
 * candidate currently being screened. Deploy recovery owns fungible wallet
 * assets, so deploy callers must serialize it with the wallet operation lock.
 */
export async function reconcilePendingDualDeploys({
  journal,
  walletAddress,
  loadPool,
  reconcile,
  alreadyWalletLocked = false,
}) {
  if (!journal || !walletAddress || typeof loadPool !== "function" || typeof reconcile !== "function") {
    throw new Error("Pending dual deploy recovery needs a journal, wallet, pool loader, and reconciler");
  }

  const operations = (await journal.list()).filter((operation) =>
    operation.walletAddress === walletAddress
  );
  const pendingExits = operations.filter((operation) => operation.kind === "exit");
  const candidates = operations.filter((operation) =>
    operation.kind !== "exit"
  );
  const outcomes = pendingExits.map((operation) => ({
    operation_id: operation.id,
    pool_address: operation.poolAddress,
    stage: operation.stage,
    kind: "exit",
    success: false,
    recovery_pending: true,
    error: "A previous dual-token exit still owns wallet assets; finish its reconciliation before another deployment",
  }));

  for (const candidate of candidates) {
    const resume = async () => {
      const operation = await journal.get(candidate.id);
      if (!operation || ["completed", "cancelled"].includes(operation.stage)) {
        return { skipped: true, operation_id: candidate.id };
      }
      const pool = await loadPool(operation.poolAddress);
      return reconcile(operation, pool);
    };

    try {
      const result = alreadyWalletLocked
        ? await resume()
        : await journal.withPoolLock(candidate.poolAddress, walletAddress, resume);
      outcomes.push({
        operation_id: candidate.id,
        pool_address: candidate.poolAddress,
        stage: candidate.stage,
        ...(result || {}),
      });
    } catch (error) {
      outcomes.push({
        operation_id: candidate.id,
        pool_address: candidate.poolAddress,
        stage: candidate.stage,
        success: false,
        recovery_pending: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    hadOperations: operations.length > 0,
    outcomes,
    pending: outcomes.filter((outcome) => outcome.recovery_pending),
    recovered: outcomes.filter((outcome) => outcome.recovered || outcome.externally_settled),
    deployed: outcomes.filter((outcome) => outcome.success && outcome.position),
  };
}
