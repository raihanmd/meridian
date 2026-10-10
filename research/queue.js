import fs from "node:fs/promises";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { repoPath } from "../repo-root.js";

export const DEFAULT_RESEARCH_DIR = repoPath("data", "token-research");

function validMint(mint) {
  if (typeof mint !== "string") return false;
  try { return new PublicKey(mint).toBase58() === mint; } catch { return false; }
}

export function jobPath(root, mint) {
  if (!validMint(mint)) throw new Error("Invalid token mint for research queue");
  return path.join(root, mint);
}

function validJob(job, mint) {
  return job?.mint === mint && typeof job.discoveredAt === "string" &&
    ["pending", "running", "ready", "sent", "failed"].includes(job.status);
}

export async function saveJob(root, job) {
  const dir = jobPath(root, job.mint);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `job.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(job, null, 2), { flag: "wx", mode: 0o600 });
    await fs.rename(temp, path.join(dir, "job.json"));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function enqueuePool(root, pool, now = Date.now()) {
  const mint = pool?.base?.mint;
  if (!validMint(mint)) return false;
  const dir = jobPath(root, mint);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "job.json");
  try {
    const existing = JSON.parse(await fs.readFile(file, "utf8"));
    if (validJob(existing, mint)) return false;
    throw new SyntaxError("Invalid research queue job");
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    if (error instanceof SyntaxError) await fs.rename(file, path.join(dir, `job.corrupt.${Date.now()}.json`));
  }
  await saveJob(root, {
    mint,
    symbol: String(pool.base.symbol || "").replace(/\s+/g, " ").trim().slice(0, 40),
    pool: String(pool.pool || ""),
    quoteMint: pool.quote?.mint || null,
    discoveredAt: new Date(now).toISOString(),
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    deliveryAttempts: 0,
    nextDeliveryAt: now,
  });
  return true;
}

export async function listJobs(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validMint(entry.name)) continue;
    try {
      const job = JSON.parse(await fs.readFile(path.join(root, entry.name, "job.json"), "utf8"));
      if (validJob(job, entry.name)) jobs.push(job);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return jobs.sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt));
}

export async function saveReport(root, mint, report) {
  const dir = jobPath(root, mint);
  const temp = path.join(dir, `report.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    await fs.rename(temp, path.join(dir, "report.json"));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function readReport(root, mint) {
  return JSON.parse(await fs.readFile(path.join(jobPath(root, mint), "report.json"), "utf8"));
}
