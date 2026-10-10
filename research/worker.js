import "../envcrypt.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, reloadScreeningThresholds } from "../config.js";
import { discoverPools } from "../tools/screening.js";
import { sendMessage } from "../telegram.js";
import { SOL_MINT } from "../token-allowlist.js";
import { DEFAULT_RESEARCH_DIR, enqueuePool, listJobs, readJudgment, readReport, saveJob, saveJudgment, saveReport } from "./queue.js";
import { runHermesResearch } from "./hermes.js";
import { formatJudgment, judgeSkillAvailable, runHermesJudgment } from "./judge.js";
import { formatReport, splitTelegram } from "./report.js";

const ROOT = process.env.RESEARCH_DIR || DEFAULT_RESEARCH_DIR;
const INTERVAL_MS = Math.max(60_000, Number(config.schedule.screeningIntervalMin || 40) * 60_000);
const MAX_RESEARCH_ATTEMPTS = 5;
const MAX_JUDGE_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
let stopping = false;

function retryDelay(attempts) {
  return Math.min(3_600_000, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
}

export async function scanResearchPools(root = ROOT, discover = discoverPools) {
  reloadScreeningThresholds();
  const result = await discover({ page_size: 50 });
  let added = 0;
  for (const pool of result.pools) {
    if (pool.base?.mint === SOL_MINT) continue;
    if (await enqueuePool(root, pool)) added++;
  }
  return { added, seen: result.pools.length, total: result.total };
}

export async function processResearchJobs(root = ROOT, { research = runHermesResearch, send = sendMessage, now = Date.now, maxJobs = Infinity, signal } = {}) {
  const jobs = await listJobs(root);
  let processed = 0;
  for (const job of jobs) {
    if (stopping || processed >= maxJobs) break;
    const current = now();
    if ((job.status === "pending" || job.status === "running") && (job.nextAttemptAt || 0) <= current) {
      processed++;
      job.status = "running";
      await saveJob(root, job);
      try {
        const report = await research(job, { root, signal });
        await saveReport(root, job.mint, report);
        job.status = "ready";
        job.nextDeliveryAt = current;
        job.error = null;
        await saveJob(root, job);
      } catch (error) {
        if (signal?.aborted) break;
        job.attempts = (job.attempts || 0) + 1;
        job.status = job.attempts >= MAX_RESEARCH_ATTEMPTS ? "failed" : "pending";
        job.nextAttemptAt = current + retryDelay(job.attempts);
        job.error = String(error.message || error).slice(0, 500);
        await saveJob(root, job);
        continue;
      }
    }
    if (job.status !== "ready" || (job.nextDeliveryAt || 0) > now()) continue;
    if (processed === 0) processed++;
    try {
      const report = await readReport(root, job.mint);
      const parts = splitTelegram(formatReport(report));
      for (let i = job.deliveredParts || 0; i < parts.length; i++) {
        const response = await send(parts.length > 1 ? `[${i + 1}/${parts.length}]\n${parts[i]}` : parts[i], { timeoutMs: 20_000 });
        if (!response?.ok) throw new Error("Telegram did not confirm delivery");
        job.deliveredParts = i + 1;
        await saveJob(root, job);
      }
      job.status = "sent";
      job.sentAt = new Date(now()).toISOString();
      job.error = null;
      await saveJob(root, job);
    } catch (error) {
      job.deliveryAttempts = (job.deliveryAttempts || 0) + 1;
      job.nextDeliveryAt = now() + retryDelay(job.deliveryAttempts);
      job.error = String(error.message || error).slice(0, 500);
      await saveJob(root, job);
    }
  }
}

export async function processJudgmentJobs(root = ROOT, { judge = runHermesJudgment, send = sendMessage, now = Date.now, maxJobs = Infinity, signal } = {}) {
  const jobs = await listJobs(root);
  let processed = 0;
  for (const job of jobs) {
    if (stopping || processed >= maxJobs) break;
    if (job.status !== "sent" || job.judgment?.status === "sent" || job.judgment?.status === "failed") continue;
    const current = now();
    job.judgment ||= { status: "pending", attempts: 0, nextAttemptAt: current, deliveryAttempts: 0, nextDeliveryAt: current, deliveredParts: 0 };
    const state = job.judgment;
    if ((state.status === "pending" || state.status === "running") && (state.nextAttemptAt || 0) <= current) {
      processed++;
      state.status = "running";
      await saveJob(root, job);
      try {
        const report = await readReport(root, job.mint);
        const judgment = await judge(report, { root, signal });
        await saveJudgment(root, job.mint, judgment);
        state.status = "ready";
        state.nextDeliveryAt = current;
        state.error = null;
        await saveJob(root, job);
      } catch (error) {
        if (signal?.aborted) break;
        state.attempts++;
        state.status = state.attempts >= MAX_JUDGE_ATTEMPTS ? "failed" : "pending";
        state.nextAttemptAt = current + retryDelay(state.attempts);
        state.error = String(error.message || error).slice(0, 500);
        await saveJob(root, job);
        continue;
      }
    }
    if (state.status !== "ready" || (state.nextDeliveryAt || 0) > now()) continue;
    if (processed === 0) processed++;
    try {
      const report = await readReport(root, job.mint);
      const judgment = await readJudgment(root, job.mint);
      const parts = splitTelegram(formatJudgment(judgment, report));
      for (let i = state.deliveredParts || 0; i < parts.length; i++) {
        const response = await send(parts.length > 1 ? `[${i + 1}/${parts.length}]\n${parts[i]}` : parts[i], { timeoutMs: 20_000 });
        if (!response?.ok) throw new Error("Telegram did not confirm judgment delivery");
        state.deliveredParts = i + 1;
        await saveJob(root, job);
      }
      state.status = "sent";
      state.sentAt = new Date(now()).toISOString();
      state.error = null;
      await saveJob(root, job);
    } catch (error) {
      state.deliveryAttempts++;
      state.nextDeliveryAt = now() + retryDelay(state.deliveryAttempts);
      state.error = String(error.message || error).slice(0, 500);
      await saveJob(root, job);
    }
  }
  return processed;
}

async function acquireLock(root) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "worker.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return async () => fs.rm(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await fs.readFile(file, "utf8").catch(() => "0"));
      try { if (pid > 0) process.kill(pid, 0); throw new Error(`Research worker already running (PID ${pid})`); }
      catch (e) { if (e.code !== "ESRCH") throw e; }
      await fs.rm(file, { force: true });
    }
  }
  throw new Error("Could not acquire research worker lock");
}

export async function main() {
  const unlock = await acquireLock(ROOT);
  const controller = new AbortController();
  const stop = () => { stopping = true; controller.abort(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let nextScanAt = 0;
    let warnedMissingJudge = false;
    while (!stopping) {
      if (Date.now() >= nextScanAt) {
        try {
          const scan = await scanResearchPools(ROOT);
          console.log(`[RESEARCH] Discovery: ${scan.added} new token(s), ${scan.seen} filtered pool(s) on current page`);
        } catch (error) {
          console.error(`[RESEARCH] Discovery failed: ${error.message}`);
        }
        nextScanAt = Date.now() + INTERVAL_MS;
      }
      try { await processResearchJobs(ROOT, { maxJobs: 1, signal: controller.signal }); }
      catch (error) { console.error(`[RESEARCH] Queue failed: ${error.message}`); }
      try {
        if (await judgeSkillAvailable()) {
          warnedMissingJudge = false;
          await processJudgmentJobs(ROOT, { maxJobs: 1, signal: controller.signal });
        } else if (!warnedMissingJudge) {
          console.warn("[RESEARCH] Syariah Judge skill belum terpasang di Hermes VPS; laporan riset tetap berjalan, penilaian menunggu skill tersedia.");
          warnedMissingJudge = true;
        }
      } catch (error) { console.error(`[RESEARCH] Judgment queue failed: ${error.message}`); }
      if (!stopping) await new Promise((resolve) => {
        const stop = () => { clearTimeout(timer); finish(); };
        const finish = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        const timer = setTimeout(finish, 15_000);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await unlock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[RESEARCH] Fatal: ${error.message}`); process.exitCode = 1; });
}
