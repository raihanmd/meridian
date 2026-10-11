import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDualOperationJournal } from "../tools/dual-operations.js";

test("journal persists staged intent, transaction signatures, and survives reopening", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-dual-journal-"));
  const filePath = path.join(directory, "operations.json");
  try {
    const journal = createDualOperationJournal({ filePath });
    const operation = await journal.create({
      idempotencyKey: "wallet:pool:range:cycle",
      poolAddress: "pool", walletAddress: "wallet", amountSol: 0.5,
    });
    await journal.transition(operation.id, "swap_x_pending", { inputAmount: "100" });
    await journal.recordTransaction(operation.id, { kind: "swap_x", signature: "sig-x" });
    const reopened = createDualOperationJournal({ filePath });
    const restored = await reopened.get(operation.id);
    assert.equal(restored.stage, "swap_x_pending");
    assert.equal(restored.inputAmount, "100");
    assert.deepEqual(restored.transactions.map((tx) => tx.signature), ["sig-x"]);
    assert.equal((await reopened.create({
      idempotencyKey: operation.idempotencyKey,
      poolAddress: "pool", walletAddress: "wallet",
    })).id, operation.id);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent updates and refuses terminal-state rewrites", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-dual-journal-"));
  const filePath = path.join(directory, "operations.json");
  try {
    const journal = createDualOperationJournal({ filePath });
    const operation = await journal.create({ idempotencyKey: "k", poolAddress: "p", walletAddress: "w" });
    await Promise.all(Array.from({ length: 8 }, (_, index) => journal.recordTransaction(operation.id, {
      kind: `kind-${index}`, signature: `sig-${index}`,
    })));
    assert.equal((await journal.get(operation.id)).transactions.length, 8);
    await journal.transition(operation.id, "completed");
    await assert.rejects(() => journal.transition(operation.id, "recovery_pending"), /terminal/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("locks deployment attempts by pool and wallet across journal instances", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-dual-lock-"));
  const filePath = path.join(directory, "operations.json");
  try {
    const first = createDualOperationJournal({ filePath });
    const second = createDualOperationJournal({ filePath });
    let active = 0;
    let peak = 0;
    const run = (journal) => journal.withPoolLock("pool", "wallet", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active--;
    });
    await Promise.all([run(first), run(second)]);
    assert.equal(peak, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the journal path cannot be durably written", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-dual-journal-"));
  try {
    const filePath = path.join(directory, "is-a-directory");
    await fs.mkdir(filePath);
    const journal = createDualOperationJournal({ filePath });
    await assert.rejects(() => journal.create({ idempotencyKey: "k", poolAddress: "p", walletAddress: "w" }), /EISDIR|durably persist/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
