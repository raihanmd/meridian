import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { repoPath } from "../repo-root.js";

const TERMINAL = new Set(["completed", "cancelled"]);
const VALID_STAGES = new Set([
  "planned", "swap_x_pending", "swap_x_confirmed", "swap_y_pending",
  "swap_y_confirmed", "position_pending", "position_confirmed",
  "exit_pending", "exit_swaps_pending", "recovery_pending", "completed", "cancelled",
]);
const locks = new Map();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withFileLock(lockPath, callback, { timeoutMs = 120_000, staleMs = 60_000 } = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), "utf8");
      await handle.sync();
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      handle = null;
      if (error.code !== "EEXIST") throw error;
      try {
        const [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
        let ownerPid = null;
        try { ownerPid = JSON.parse(raw).pid; } catch { /* malformed old lock */ }
        let ownerAlive = false;
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          try { process.kill(ownerPid, 0); ownerAlive = true; } catch (probeError) { ownerAlive = probeError.code === "EPERM"; }
        }
        if (!ownerAlive && Date.now() - stat.mtimeMs > staleMs) await fs.unlink(lockPath).catch(() => {});
      } catch (readError) {
        if (readError.code !== "ENOENT") throw readError;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for durable operation lock ${path.basename(lockPath)}`);
      await sleep(75 + Math.floor(Math.random() * 100));
    }
  }

  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    try {
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (owner.token === token) await fs.unlink(lockPath);
    } catch { /* lock may already have been reclaimed */ }
  }
}

function freshJournal() {
  return { version: 1, operations: [] };
}

async function readJournal(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.operations)) throw new Error("Unsupported dual-operation journal format");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return freshJournal();
    throw error;
  }
}

async function writeJournal(filePath, journal) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    const dirHandle = await fs.open(directory, "r");
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw new Error(`Could not durably persist dual operation journal: ${error.message}`);
  }
}

async function updateJournal(filePath, updater) {
  const prior = locks.get(filePath) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = prior.then(() => current);
  locks.set(filePath, queued);
  await prior;
  try {
    return await withFileLock(`${filePath}.write.lock`, async () => {
      const journal = await readJournal(filePath);
      const result = await updater(journal);
      await writeJournal(filePath, journal);
      return result;
    });
  } finally {
    release();
    if (locks.get(filePath) === queued) locks.delete(filePath);
  }
}

export function createDualOperationJournal({ filePath = repoPath("dual-operations.json") } = {}) {
  return {
    async withPoolLock(poolAddress, walletAddress, callback) {
      if (!poolAddress || !walletAddress || typeof callback !== "function") throw new Error("Pool operation lock needs pool, wallet, and callback");
      // Every dual operation for one wallet shares fungible token balances.
      // Serialize across pools so rollback for one operation cannot spend
      // tokens acquired by another concurrent operation.
      const key = createHash("sha256").update(walletAddress).digest("hex");
      return withFileLock(`${filePath}.${key}.wallet-operation.lock`, callback, { timeoutMs: 180_000 });
    },
    async list({ includeTerminal = false } = {}) {
      const journal = await readJournal(filePath);
      return journal.operations.filter((operation) => includeTerminal || !TERMINAL.has(operation.stage));
    },
    async get(id) {
      const journal = await readJournal(filePath);
      return journal.operations.find((operation) => operation.id === id) ?? null;
    },
    async create({ idempotencyKey, poolAddress, walletAddress, ...details }) {
      if (!idempotencyKey || !poolAddress || !walletAddress) throw new Error("Dual operation needs idempotencyKey, poolAddress, and walletAddress");
      return updateJournal(filePath, (journal) => {
        const existing = journal.operations.find((operation) => operation.idempotencyKey === idempotencyKey);
        if (existing) return existing;
        const now = new Date().toISOString();
        const operation = {
          id: randomUUID(), idempotencyKey, poolAddress, walletAddress,
          stage: "planned", createdAt: now, updatedAt: now,
          transactions: [], ...details,
        };
        journal.operations.push(operation);
        return operation;
      });
    },
    async transition(id, stage, patch = {}) {
      if (!VALID_STAGES.has(stage)) throw new Error(`Unknown dual operation stage: ${stage}`);
      return updateJournal(filePath, (journal) => {
        const operation = journal.operations.find((entry) => entry.id === id);
        if (!operation) throw new Error(`Dual operation ${id} does not exist`);
        if (TERMINAL.has(operation.stage) && operation.stage !== stage) throw new Error(`Cannot change terminal dual operation ${operation.stage}`);
        Object.assign(operation, patch, { stage, updatedAt: new Date().toISOString() });
        return operation;
      });
    },
    async recordTransaction(id, { kind, signature, status = "submitted", metadata = {}, operationPatch = {} }) {
      if (!kind || !signature) throw new Error("Transaction record needs kind and signature");
      return updateJournal(filePath, (journal) => {
        const operation = journal.operations.find((entry) => entry.id === id);
        if (!operation) throw new Error(`Dual operation ${id} does not exist`);
        const existing = operation.transactions.find((tx) => tx.signature === signature);
        if (!existing) operation.transactions.push({ kind, signature, status, metadata, recordedAt: new Date().toISOString() });
        else Object.assign(existing, { kind, status, metadata: { ...existing.metadata, ...metadata }, updatedAt: new Date().toISOString() });
        Object.assign(operation, operationPatch, { updatedAt: new Date().toISOString() });
        return operation;
      });
    },
  };
}

export const dualOperationJournal = createDualOperationJournal();
