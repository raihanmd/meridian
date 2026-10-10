import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RESEARCH_DIR, jobPath, listJobs, saveJob } from "./queue.js";

export async function retryFailedResearch(mint, root = process.env.RESEARCH_DIR || DEFAULT_RESEARCH_DIR) {
  const dir = jobPath(root, mint);
  const job = JSON.parse(await fs.readFile(path.join(dir, "job.json"), "utf8"));
  if (job.mint !== mint || job.status !== "failed") throw new Error("Only a failed research job can be retried");
  job.status = "pending";
  job.attempts = 0;
  job.nextAttemptAt = Date.now();
  job.error = null;
  await saveJob(root, job);
}

export async function retryAllFailedResearch(root = process.env.RESEARCH_DIR || DEFAULT_RESEARCH_DIR) {
  let count = 0;
  for (const job of await listJobs(root)) {
    if (job.status !== "failed") continue;
    await retryFailedResearch(job.mint, root);
    count++;
  }
  return count;
}

export async function retryFailedJudgment(mint, root = process.env.RESEARCH_DIR || DEFAULT_RESEARCH_DIR) {
  const dir = jobPath(root, mint);
  const job = JSON.parse(await fs.readFile(path.join(dir, "job.json"), "utf8"));
  if (job.mint !== mint || job.status !== "sent" || job.judgment?.status !== "failed") {
    throw new Error("Only a failed judgment for a sent research report can be retried");
  }
  job.judgment.status = "pending";
  job.judgment.attempts = 0;
  job.judgment.nextAttemptAt = Date.now();
  job.judgment.error = null;
  await saveJob(root, job);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const judge = process.argv[2] === "--judge";
  const all = !judge && process.argv[2] === "--all";
  (judge ? retryFailedJudgment(process.argv[3]) : all ? retryAllFailedResearch() : retryFailedResearch(process.argv[2])).then(
    (count) => console.log(all ? `${count} failed research job(s) queued for retry` : `${judge ? "Judgment" : "Research"} job queued for retry`),
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
