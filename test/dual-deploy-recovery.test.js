import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePendingDualDeploys } from "../tools/dual-deploy-recovery.js";

function fakeJournal(operations) {
  const locks = [];
  return {
    locks,
    async list() { return operations.filter((operation) => !["completed", "cancelled"].includes(operation.stage)); },
    async get(id) { return operations.find((operation) => operation.id === id) ?? null; },
    async withPoolLock(pool, wallet, callback) {
      locks.push({ pool, wallet });
      return callback();
    },
  };
}

test("wallet-wide recovery scans pending deploys across pools and blocks on pending exits", async () => {
  const journal = fakeJournal([
    { id: "old-deploy", kind: null, stage: "recovery_pending", poolAddress: "old-pool", walletAddress: "wallet" },
    { id: "other-wallet", kind: "deploy", stage: "recovery_pending", poolAddress: "other-pool", walletAddress: "someone-else" },
    { id: "exit", kind: "exit", stage: "exit_swaps_pending", poolAddress: "exit-pool", walletAddress: "wallet" },
    { id: "done", kind: "deploy", stage: "completed", poolAddress: "done-pool", walletAddress: "wallet" },
  ]);
  const loaded = [];
  const reconciled = [];

  const result = await reconcilePendingDualDeploys({
    journal,
    walletAddress: "wallet",
    loadPool: async (address) => { loaded.push(address); return { address }; },
    reconcile: async (operation, pool) => { reconciled.push([operation.id, pool.address]); return { success: false, recovery_pending: true, error: "old assets need review" }; },
  });

  assert.deepEqual(loaded, ["old-pool"]);
  assert.deepEqual(reconciled, [["old-deploy", "old-pool"]]);
  assert.equal(result.hadOperations, true);
  assert.equal(result.pending.length, 2);
  assert.deepEqual(result.pending.map((outcome) => outcome.operation_id).sort(), ["exit", "old-deploy"]);
  assert.match(result.pending.find((outcome) => outcome.operation_id === "exit").error, /exit still owns wallet assets/);
  assert.deepEqual(journal.locks, [{ pool: "old-pool", wallet: "wallet" }]);
});

test("recovery failures remain blocking and do not prevent checking later operations", async () => {
  const journal = fakeJournal([
    { id: "unavailable-pool", kind: "deploy", stage: "position_pending", poolAddress: "missing", walletAddress: "wallet" },
    { id: "second", kind: "deploy", stage: "recovery_pending", poolAddress: "second-pool", walletAddress: "wallet" },
  ]);
  const result = await reconcilePendingDualDeploys({
    journal,
    walletAddress: "wallet",
    loadPool: async (address) => {
      if (address === "missing") throw new Error("RPC unavailable");
      return { address };
    },
    reconcile: async () => ({ success: false, recovery_pending: true, error: "position still open" }),
  });

  assert.equal(result.pending.length, 2);
  assert.match(result.pending[0].error, /RPC unavailable/);
  assert.match(result.pending[1].error, /position still open/);
});

test("a position recovered from an operation stops the caller from starting another deploy", async () => {
  const journal = fakeJournal([
    { id: "confirmed-position", kind: "deploy", stage: "recovery_pending", poolAddress: "old-pool", walletAddress: "wallet" },
  ]);
  const result = await reconcilePendingDualDeploys({
    journal,
    walletAddress: "wallet",
    loadPool: async (address) => ({ address }),
    reconcile: async () => ({ success: true, position: "position-account" }),
  });

  assert.equal(result.deployed.length, 1);
  assert.equal(result.deployed[0].position, "position-account");
  assert.equal(result.hadOperations, true);
});

test("already-held wallet lock avoids nested lock acquisition in the deploy path", async () => {
  const journal = fakeJournal([
    { id: "pending", kind: "deploy", stage: "recovery_pending", poolAddress: "pool", walletAddress: "wallet" },
  ]);
  await reconcilePendingDualDeploys({
    journal,
    walletAddress: "wallet",
    loadPool: async (address) => ({ address }),
    reconcile: async () => ({ success: false, recovery_pending: true }),
    alreadyWalletLocked: true,
  });
  assert.deepEqual(journal.locks, []);
});
