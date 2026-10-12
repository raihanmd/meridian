import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDualOperationJournal } from "../tools/dual-operations.js";
import { reconcileExternallySettledDualExit } from "../tools/dual-exit-reconciliation.js";

async function withExit(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-manual-exit-"));
  try {
    const journal = createDualOperationJournal({ filePath: path.join(directory, "operations.json") });
    const operation = await journal.create({
      idempotencyKey: "dual-exit:position",
      poolAddress: "pool",
      walletAddress: "wallet",
      kind: "exit",
      positionAddress: "position",
      assetsRemaining: { token: { mint: "token", amount_raw: "2233228114394", decimals: 9 } },
      solReceivedLamports: "0",
    });
    await journal.transition(operation.id, "exit_swaps_pending");
    return await callback(journal, await journal.get(operation.id));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("clears a manually settled exit only after confirming absent position and zero wallet token balance", () => withExit(async (journal, operation) => {
  const checks = [];
  const result = await reconcileExternallySettledDualExit({
    journal,
    operation,
    readPositionAccount: async (address) => { checks.push(address); return null; },
    readMintBalance: async (owner, mint) => { checks.push(`${owner}:${mint}`); return "0"; },
  });
  assert.deepEqual(checks, ["position", "wallet:token"]);
  assert.equal(result.stage, "completed");
  assert.equal(result.assetsRemaining.token.amount_raw, "0");
  assert.equal(result.solReceivedLamports, "0");
  assert.equal(result.externalSettlement.solProceedsVerified, false);
  assert.equal((await journal.list()).length, 0);
  assert.equal((await journal.get(operation.id)).stage, "completed");
}));

test("does not clear an exit while the position exists or any token remains", () => withExit(async (journal, operation) => {
  const existingPosition = await reconcileExternallySettledDualExit({
    journal, operation,
    readPositionAccount: async () => ({}),
    readMintBalance: async () => { throw new Error("balance should not be read"); },
  });
  assert.equal(existingPosition, null);
  const remainingTokens = await reconcileExternallySettledDualExit({
    journal, operation,
    readPositionAccount: async () => null,
    readMintBalance: async () => "1",
  });
  assert.equal(remainingTokens, null);
  assert.equal((await journal.get(operation.id)).assetsRemaining.token.amount_raw, "2233228114394");
  assert.equal((await journal.get(operation.id)).stage, "exit_swaps_pending");
}));

test("does not infer manual settlement when a bot transaction exists or RPC reads fail", () => withExit(async (journal, operation) => {
  await journal.recordTransaction(operation.id, { kind: "exit_swap:token", signature: "signed", status: "signed" });
  const pending = await journal.get(operation.id);
  assert.equal(await reconcileExternallySettledDualExit({
    journal, operation: pending,
    readPositionAccount: async () => null,
    readMintBalance: async () => "0",
  }), null);
  assert.equal((await journal.get(operation.id)).stage, "exit_swaps_pending");

  await assert.rejects(() => reconcileExternallySettledDualExit({
    journal, operation,
    readPositionAccount: async () => { throw new Error("RPC unavailable"); },
    readMintBalance: async () => "0",
  }), /RPC unavailable/);
  assert.equal((await journal.get(operation.id)).stage, "exit_swaps_pending");
}));

test("allows external clearance after an expired bot quote that never executed", () => withExit(async (journal, operation) => {
  await journal.recordTransaction(operation.id, { kind: "exit_swap:token", signature: "expired", status: "expired" });
  const result = await reconcileExternallySettledDualExit({
    journal, operation: await journal.get(operation.id),
    readPositionAccount: async () => null,
    readMintBalance: async () => "0",
  });
  assert.equal(result.stage, "completed");
  assert.equal(result.externalSettlement.solProceedsVerified, false);
}));

test("a two-token exit remains pending if either wallet token is nonzero", () => withExit(async (journal, operation) => {
  await journal.transition(operation.id, "exit_swaps_pending", {
    assetsRemaining: {
      ...operation.assetsRemaining,
      other: { mint: "other", amount_raw: "50", decimals: 6 },
    },
  });
  const current = await journal.get(operation.id);
  const result = await reconcileExternallySettledDualExit({
    journal, operation: current,
    readPositionAccount: async () => null,
    readMintBalance: async (_owner, mint) => mint === "other" ? "1" : "0",
  });
  assert.equal(result, null);
  assert.equal((await journal.get(operation.id)).stage, "exit_swaps_pending");
}));
