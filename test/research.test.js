import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { enqueuePool, listJobs, readReport } from "../research/queue.js";
import { runHermesResearch } from "../research/hermes.js";
import { parseReport, splitTelegram } from "../research/report.js";
import { retryFailedResearch } from "../research/retry.js";
import { processResearchJobs, scanResearchPools } from "../research/worker.js";
import { SOL_MINT } from "../token-allowlist.js";

const MINT = "7KEPApdbBMByrmqihz3bht2uMhFQcatjfSFQCKq66kH3";
const OTHER = "BBKPiLM9KjdJW7oQSKt99RVWcZdhF6sEHRKnwqeBGHST";
const pool = (mint, address = "pool") => ({ pool: address, base: { mint, symbol: "DARK" }, quote: { mint: SOL_MINT } });
const report = (mint = MINT) => ({
  mint, projectName: "DarkSwap", category: "defi", confidence: "medium", summary: "Privacy swap interface.",
  businessModel: "Swap fee", website: "https://darkswap.app", websiteVerified: true,
  identityEvidence: "Mint appears in project docs", cautions: "Verify independently",
  sources: [{ title: "Docs", url: "https://darkswap.app/docs", note: "Fee model" }],
});

test("research queue deduplicates mints across pools and survives restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await enqueuePool(root, pool(MINT, "pool-a")), true);
  assert.equal(await enqueuePool(root, pool(MINT, "pool-b")), false);
  assert.deepEqual((await listJobs(root)).map((job) => job.mint), [MINT]);
  assert.equal(await enqueuePool(root, pool("../bad")), false);
});

test("corrupt queue state is preserved and recreated on the next discovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  await fs.writeFile(path.join(root, MINT, "job.json"), "{broken");
  assert.equal((await listJobs(root)).length, 0);
  assert.equal(await enqueuePool(root, pool(MINT)), true);
  assert.equal((await listJobs(root)).length, 1);
  assert.ok((await fs.readdir(path.join(root, MINT))).some((name) => name.startsWith("job.corrupt.")));
});

test("scanner queues screened tokens even when allowlist is empty", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await scanResearchPools(root, async () => ({ pools: [pool(MINT), pool(OTHER), pool(SOL_MINT)], total: 3 }));
  assert.equal(result.added, 2);
  assert.equal((await listJobs(root)).length, 2);
});

test("report rejects wrong mint and preserves source URLs", () => {
  assert.throws(() => parseReport(JSON.stringify(report(OTHER)), { mint: MINT, symbol: "DARK" }), /mint does not match/);
  const parsed = parseReport(JSON.stringify(report()), { mint: MINT, symbol: "DARK" });
  assert.equal(parsed.sources[0].url, "https://darkswap.app/docs");
  assert.equal(parsed.websiteVerified, false);
  assert.ok(splitTelegram("a\n".repeat(5000)).every((part) => part.length <= 3900));
});

test("Hermes receives a prompt file and only the web toolset, without Meridian wallet secrets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  const spawnFn = (_bin, args, options) => {
    assert.deepEqual(args.slice(0, 2), ["chat", "--query-file"]);
    assert.equal(args[args.indexOf("--toolsets") + 1], "web");
    assert.equal(options.env.WALLET_PRIVATE_KEY, undefined);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "result", exit_code: 0, text: JSON.stringify(report()) }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
  const result = await runHermesResearch({ mint: MINT, symbol: "DARK", pool: "pool" }, { root, spawnFn });
  assert.equal(result.mint, MINT);
  assert.match(await fs.readFile(path.join(root, MINT, "prompt.txt"), "utf8"), /EXACT mint/);
});

test("research retries failure and delivery retries from saved report", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT), 1_000);
  let researchCalls = 0;
  let deliveries = 0;
  const research = async (job) => {
    researchCalls++;
    if (researchCalls === 1) throw new Error("temporary provider failure");
    return parseReport(JSON.stringify(report()), job);
  };
  const send = async () => { deliveries++; return deliveries === 1 ? null : { ok: true }; };
  let now = 1_000;
  const options = { research, send, now: () => now };
  await processResearchJobs(root, options);
  let [job] = await listJobs(root);
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  now = job.nextAttemptAt;
  await processResearchJobs(root, options);
  [job] = await listJobs(root);
  assert.equal(job.status, "ready");
  assert.equal(job.deliveryAttempts, 1);
  assert.equal((await readReport(root, MINT)).mint, MINT);
  now = job.nextDeliveryAt;
  await processResearchJobs(root, options);
  [job] = await listJobs(root);
  assert.equal(job.status, "sent");
  assert.equal(researchCalls, 2);
  assert.equal(deliveries, 2);
});

test("exhausted research remains inspectable and can be manually retried", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT), 1_000);
  let now = 1_000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await processResearchJobs(root, { now: () => now, research: async () => { throw new Error("No Hermes model configured"); } });
    const [job] = await listJobs(root);
    assert.equal(job.attempts, attempt);
    now = job.nextAttemptAt;
  }
  let [job] = await listJobs(root);
  assert.equal(job.status, "failed");
  await retryFailedResearch(MINT, root);
  [job] = await listJobs(root);
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 0);
});

test("Telegram retries resume at the first undelivered report part", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT), 1_000);
  const longReport = parseReport(JSON.stringify({
    ...report(), summary: "Summary ".repeat(250), productStatus: "Live ".repeat(250),
    businessModel: "Fees ".repeat(250), tokenUtility: "Utility ".repeat(200),
    cautions: "Risk ".repeat(240),
  }), { mint: MINT, symbol: "DARK" });
  const sent = [];
  let now = 1_000;
  const send = async (text) => {
    sent.push(text);
    return sent.length === 2 ? null : { ok: true };
  };
  await processResearchJobs(root, { now: () => now, research: async () => longReport, send });
  let [job] = await listJobs(root);
  assert.equal(job.status, "ready");
  assert.equal(job.deliveredParts, 1);
  now = job.nextDeliveryAt;
  await processResearchJobs(root, { now: () => now, research: async () => { throw new Error("must not rerun research"); }, send });
  [job] = await listJobs(root);
  assert.equal(job.status, "sent");
  assert.equal(sent[1], sent[2]);
  assert.notEqual(sent[0], sent[2]);
});
