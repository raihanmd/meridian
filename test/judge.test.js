import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { enqueuePool, listJobs, readJudgment, saveJob, saveReport } from "../research/queue.js";
import { judgePrompt, judgeSkillPath, parseJudgment, runHermesJudgment } from "../research/judge.js";
import { retryFailedJudgment } from "../research/retry.js";
import { processJudgmentJobs } from "../research/worker.js";
import { SOL_MINT } from "../token-allowlist.js";

const MINT = "7KEPApdbBMByrmqihz3bht2uMhFQcatjfSFQCKq66kH3";
const SOURCE = "https://example.org/token-terms";
const report = () => ({
  mint: MINT, projectName: "Example", discoveredSymbol: "EX", identityEvidence: "Mint in official terms",
  businessModel: "Software service fees", tokenRights: "Holders may use a service; no revenue claim per terms",
  revenueFlows: "Service fees accrue to issuer", issuanceProceeds: "Issuer receives sale proceeds",
  treasuryRelation: "Corporate treasury does not back token or accrue to holders",
  backingRedemption: "No redemption claim per terms",
  sources: [{ title: "Terms", url: SOURCE, note: "Token rights and financial flows" }],
});
const judgment = (status = "tidak_ditemukan_isu", url = SOURCE) => ({
  mint: MINT, status, confidence: "medium", summary: "Initial review of token rights.",
  findings: [{ area: "treasury", observation: "Issuer treasury is separate", reason: "No holder claim to assets", sourceUrls: [url] }],
  openQuestions: ["Verify current terms"],
});

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-judge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, { pool: "pool", base: { mint: MINT, symbol: "EX" }, quote: { mint: SOL_MINT } }, 1_000);
  const [job] = await listJobs(root);
  job.status = "sent";
  await saveJob(root, job);
  await saveReport(root, MINT, report());
  return root;
}

test("judge abstains if key fields or cited evidence are missing", () => {
  const sparse = { ...report(), tokenRights: "Unknown" };
  assert.equal(parseJudgment(JSON.stringify(judgment()), sparse).status, "bukti_belum_cukup");
  const unsupported = judgment("indikasi_masalah_kuat", "https://invented.example/claim");
  const parsed = parseJudgment(JSON.stringify(unsupported), report());
  assert.equal(parsed.status, "bukti_belum_cukup");
  assert.equal(parsed.findings.length, 0);
  assert.throws(() => parseJudgment(JSON.stringify({ ...judgment(), mint: SOL_MINT }), report()), /mint does not match/);
});

test("judge prompt distinguishes issuer treasury and token backing", () => {
  assert.match(judgePrompt(report()), /unrelated to holder rights/);
  assert.match(judgePrompt(report()), /token reserves, backing, redemption/);
});

test("judge skill lookup uses Hermes home rather than the user's home directory", () => {
  const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  assert.equal(judgeSkillPath(), path.join(hermesHome, "skills", "research", "syariah-judge", "SKILL.md"));
});

test("Hermes judgment preloads the VPS skill without web access or Meridian secrets", async (t) => {
  const root = await setup(t);
  const spawnFn = (_bin, args, options) => {
    assert.equal(args[args.indexOf("--skills") + 1], "syariah-judge");
    assert.equal(args[args.indexOf("--toolsets") + 1], "skills");
    assert.equal(args.includes("--ignore-rules"), false);
    assert.equal(options.env.WALLET_PRIVATE_KEY, undefined);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "result", exit_code: 0, text: JSON.stringify(judgment()) }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
  const result = await runHermesJudgment(report(), { root, spawnFn });
  assert.equal(result.status, "tidak_ditemukan_isu");
});

test("judgment retries independently after the research report was sent", async (t) => {
  const root = await setup(t);
  let now = 1_000;
  let judgeCalls = 0;
  let sendCalls = 0;
  const notifications = [];
  const options = {
    now: () => now,
    judge: async () => { judgeCalls++; if (judgeCalls === 1) throw new Error("temporary error"); return parseJudgment(JSON.stringify(judgment()), report()); },
    send: async (text) => { notifications.push(text); sendCalls++; return sendCalls === 1 ? null : { ok: true }; },
  };
  await processJudgmentJobs(root, options);
  let [job] = await listJobs(root);
  assert.equal(job.status, "sent");
  assert.equal(job.judgment.status, "pending");
  now = job.judgment.nextAttemptAt;
  await processJudgmentJobs(root, options);
  [job] = await listJobs(root);
  assert.equal(job.judgment.status, "ready");
  assert.equal((await readJudgment(root, MINT)).mint, MINT);
  now = job.judgment.nextDeliveryAt;
  await processJudgmentJobs(root, options);
  [job] = await listJobs(root);
  assert.equal(job.judgment.status, "sent");
  assert.equal(judgeCalls, 2);
  assert.equal(sendCalls, 2);
  assert.ok(notifications.every((text) => text.startsWith("⚖️ KAJIAN SYARIAH · EX")));
});

test("failed judgment remains inspectable and can be retried manually", async (t) => {
  const root = await setup(t);
  let now = 1_000;
  for (let i = 1; i <= 3; i++) {
    await processJudgmentJobs(root, { now: () => now, judge: async () => { throw new Error("Hermes unavailable"); } });
    const [job] = await listJobs(root);
    assert.equal(job.judgment.attempts, i);
    now = job.judgment.nextAttemptAt;
  }
  let [job] = await listJobs(root);
  assert.equal(job.judgment.status, "failed");
  assert.equal(job.status, "sent");
  await retryFailedJudgment(MINT, root);
  [job] = await listJobs(root);
  assert.equal(job.judgment.status, "pending");
});
