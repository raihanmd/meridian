import "../envcrypt.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { sendMessage } from "../telegram.js";
import { DEFAULT_RESEARCH_DIR, listJobs, readJudgment, readReport, saveJob, saveJudgment, saveReport } from "./queue.js";
import { runHermesResearch } from "./hermes.js";
import { formatJudgment, judgeSkillAvailable, runHermesJudgment } from "./judge.js";
import { formatReport, splitTelegram } from "./report.js";

const ROOT = process.env.RESEARCH_DIR || DEFAULT_RESEARCH_DIR;
const INTERVAL_MS = Math.max(60_000, Number(config.schedule.screeningIntervalMin || 40) * 60_000);
const MAX_RESEARCH_ATTEMPTS = 5;
const MAX_JUDGE_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
let stopping = false;
let activeController = null;
let backgroundWorker = null;

function retryDelay(attempts) {
  return Math.min(3_600_000, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
}

export function formatResearchHeartbeat(jobs) {
  const researchPending = jobs.filter((job) => ["pending", "running", "ready"].includes(job.status)).length;
  const researchFailed = jobs.filter((job) => job.status === "failed").length;
  const judgmentPending = jobs.filter((job) => job.status === "sent" && !["sent", "failed"].includes(job.judgment?.status)).length;
  return [
    "🧪 Meridian research worker aktif",
    `Riset menunggu/berjalan: ${researchPending} | gagal: ${researchFailed}`,
    `Kajian Syariah menunggu/berjalan: ${judgmentPending}`,
    "Mint baru masuk antrean saat bot utama menemukan pool yang lolos filter.",
  ].join("\n");
}

export async function announceResearchHeartbeat(jobs, send = sendMessage) {
  const response = await send(formatResearchHeartbeat(jobs), { timeoutMs: 15_000 });
  if (!response?.ok) throw new Error("Telegram did not confirm research heartbeat delivery");
}

export async function requeueLegacyUnverifiedReports(root = ROOT, now = Date.now()) {
  let requeued = 0;
  for (const job of await listJobs(root)) {
    if (!["ready", "sent"].includes(job.status)) continue;
    let report;
    try { report = await readReport(root, job.mint); }
    catch { continue; }
    if (report?.webAccessCheck || report?.sources?.length) continue;
    job.status = "pending";
    job.attempts = 0;
    job.nextAttemptAt = now;
    job.deliveryAttempts = 0;
    job.nextDeliveryAt = now;
    job.deliveredParts = 0;
    job.judgment = null;
    job.error = null;
    delete job.sentAt;
    await saveJob(root, job);
    requeued++;
  }
  return requeued;
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
        console.log(`[RESEARCH] Report ready for ${job.mint}`);
      } catch (error) {
        if (signal?.aborted) break;
        job.attempts = (job.attempts || 0) + 1;
        job.status = job.attempts >= MAX_RESEARCH_ATTEMPTS ? "failed" : "pending";
        job.nextAttemptAt = current + retryDelay(job.attempts);
        job.error = String(error.message || error).slice(0, 500);
        await saveJob(root, job);
        console.warn(`[RESEARCH] ${job.mint} attempt ${job.attempts}/${MAX_RESEARCH_ATTEMPTS}: ${job.error}`);
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
      console.log(`[RESEARCH] Report sent for ${job.mint}`);
    } catch (error) {
      job.deliveryAttempts = (job.deliveryAttempts || 0) + 1;
      job.nextDeliveryAt = now() + retryDelay(job.deliveryAttempts);
      job.error = String(error.message || error).slice(0, 500);
      await saveJob(root, job);
      console.warn(`[RESEARCH] Report delivery retry for ${job.mint}: ${job.error}`);
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
        console.log(`[RESEARCH] Judgment ready for ${job.mint}: ${judgment.status}`);
      } catch (error) {
        if (signal?.aborted) break;
        state.attempts++;
        state.status = state.attempts >= MAX_JUDGE_ATTEMPTS ? "failed" : "pending";
        state.nextAttemptAt = current + retryDelay(state.attempts);
        state.error = String(error.message || error).slice(0, 500);
        await saveJob(root, job);
        console.warn(`[RESEARCH] Judgment ${job.mint} attempt ${state.attempts}/${MAX_JUDGE_ATTEMPTS}: ${state.error}`);
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
      console.log(`[RESEARCH] Judgment sent for ${job.mint}`);
    } catch (error) {
      state.deliveryAttempts++;
      state.nextDeliveryAt = now() + retryDelay(state.deliveryAttempts);
      state.error = String(error.message || error).slice(0, 500);
      await saveJob(root, job);
      console.warn(`[RESEARCH] Judgment delivery retry for ${job.mint}: ${state.error}`);
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
  stopping = false;
  const unlock = await acquireLock(ROOT);
  const controller = new AbortController();
  activeController = controller;
  const stop = () => { stopping = true; controller.abort(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const requeued = await requeueLegacyUnverifiedReports(ROOT);
    if (requeued) console.log(`[RESEARCH] Requeued ${requeued} old report(s) made without verified web search`);
    let nextHeartbeatAt = 0;
    let warnedMissingJudge = false;
    while (!stopping) {
      if (Date.now() >= nextHeartbeatAt) {
        try {
          const jobs = await listJobs(ROOT);
          console.log(`[RESEARCH] Worker alive; ${jobs.length} token job(s) on disk`);
          announceResearchHeartbeat(jobs)
            .then(() => console.log("[RESEARCH] Worker heartbeat sent to Telegram"))
            .catch((error) => console.warn(`[RESEARCH] Worker heartbeat notification failed: ${error.message}`));
        } catch (error) {
          console.error(`[RESEARCH] Queue heartbeat failed: ${error.message}`);
        }
        nextHeartbeatAt = Date.now() + INTERVAL_MS;
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
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 15_000);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
    }
  } finally {
    activeController = null;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await unlock();
  }
}

export function startBackgroundResearchWorker() {
  if (backgroundWorker) return backgroundWorker;
  let cancelled = false;
  let wakeRetry = null;
  const done = (async () => {
    while (!cancelled) {
      try { await main(); }
      catch (error) { console.error(`[RESEARCH] Worker stopped unexpectedly: ${error.message}`); }
      if (cancelled) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        wakeRetry = () => { clearTimeout(timer); resolve(); };
      });
      wakeRetry = null;
    }
  })();
  const handle = {
    done,
    async stop() {
      cancelled = true;
      stopping = true;
      activeController?.abort();
      wakeRetry?.();
      await done;
    },
  };
  backgroundWorker = handle;
  done.finally(() => { if (backgroundWorker === handle) backgroundWorker = null; });
  return handle;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[RESEARCH] Fatal: ${error.message}`); process.exitCode = 1; });
}
