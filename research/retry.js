import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RESEARCH_DIR, jobPath, saveJob } from "./queue.js";

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
  (judge ? retryFailedJudgment(process.argv[3]) : retryFailedResearch(process.argv[2])).then(
    () => console.log(`${judge ? "Judgment" : "Research"} job queued for retry`),
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
