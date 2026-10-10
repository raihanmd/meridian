import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { enqueuePool, enqueueResearchCandidates, listJobs, readReport, saveJob, saveReport } from "../research/queue.js";
import { hermesEnv, runHermesResearch } from "../research/hermes.js";
import { parseReport, splitTelegram } from "../research/report.js";
import { retryFailedResearch } from "../research/retry.js";
import { announceResearchHeartbeat, formatResearchHeartbeat, processResearchJobs, requeueLegacyUnverifiedReports } from "../research/worker.js";
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

test("concurrent discovery writes cannot replace an existing research job", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const results = await Promise.all([enqueuePool(root, pool(MINT)), enqueuePool(root, pool(MINT))]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await listJobs(root)).length, 1);
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

test("main discovery queues screened tokens even when allowlist is empty", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await enqueueResearchCandidates(root, [pool(MINT), pool(OTHER), pool(SOL_MINT)]);
  assert.equal(result.added, 2);
  assert.equal((await listJobs(root)).length, 2);
});

test("research worker heartbeat reports queue health without fetching pools", async () => {
  const message = formatResearchHeartbeat([{ status: "pending" }, { status: "failed" }, { status: "sent", judgment: { status: "pending" } }]);
  assert.match(message, /Riset menunggu\/berjalan: 1 \| gagal: 1/);
  assert.match(message, /Kajian Syariah menunggu\/berjalan: 1/);
  await announceResearchHeartbeat([], async (text) => { assert.match(text, /worker aktif/); return { ok: true }; });
});

test("old source-less reports are requeued once for verified web research", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  const [job] = await listJobs(root);
  job.status = "sent";
  job.judgment = { status: "sent" };
  await saveJob(root, job);
  await saveReport(root, MINT, parseReport(JSON.stringify({ ...report(), sources: [] }), job));
  assert.equal(await requeueLegacyUnverifiedReports(root, 1000), 1);
  const [requeued] = await listJobs(root);
  assert.equal(requeued.status, "pending");
  assert.equal(requeued.nextAttemptAt, 1000);
  assert.equal(requeued.judgment, null);
  assert.equal(await requeueLegacyUnverifiedReports(root, 1000), 0);
});

test("Hermes receives web provider credentials but not Meridian wallet secrets", () => {
  const previous = process.env.FIRECRAWL_API_KEY;
  const previousUrl = process.env.FIRECRAWL_API_URL;
  process.env.FIRECRAWL_API_KEY = "test-web-key";
  process.env.FIRECRAWL_API_URL = "http://127.0.0.1:3002";
  try {
    assert.equal(hermesEnv().FIRECRAWL_API_KEY, "test-web-key");
    assert.equal(hermesEnv().FIRECRAWL_API_URL, "http://127.0.0.1:3002");
    assert.equal(hermesEnv().WALLET_PRIVATE_KEY, undefined);
    assert.equal(hermesEnv().TELEGRAM_BOT_TOKEN, undefined);
  } finally {
    if (previous === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = previous;
    if (previousUrl === undefined) delete process.env.FIRECRAWL_API_URL;
    else process.env.FIRECRAWL_API_URL = previousUrl;
  }
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
      child.stdout.write(JSON.stringify({ type: "tool_result", name: "web_search", is_error: false, output: '{"success":true,"data":{"web":[]}}' }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", exit_code: 0, text: JSON.stringify(report()) }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
  const result = await runHermesResearch({ mint: MINT, symbol: "DARK", pool: "pool" }, { root, spawnFn });
  assert.equal(result.mint, MINT);
  assert.equal(result.webAccessCheck, "tool-result");
  assert.match(await fs.readFile(path.join(root, MINT, "prompt.txt"), "utf8"), /EXACT mint/);
});

test("older Hermes CLI accepts only a sourced plain one-shot report", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  let calls = 0;
  const spawnFn = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      calls++;
      if (calls === 1) {
        assert.ok(args.includes("--query-file"));
        child.stderr.write("error: unrecognized arguments: --query-file\n");
        child.emit("close", 2);
      } else {
        assert.deepEqual(args.slice(0, 3), ["chat", "-Q", "-q"]);
        assert.equal(args[args.indexOf("--toolsets") + 1], "web");
        assert.equal(args.includes("--format"), false);
        child.stdout.write(`${JSON.stringify(report())}\n\nsession_id: 20261010_173501_63825b\n`);
        child.emit("close", 0);
      }
    });
    return child;
  };
  const result = await runHermesResearch({ mint: MINT, symbol: "DARK", pool: "pool" }, { root, spawnFn });
  assert.equal(result.mint, MINT);
  assert.equal(result.webAccessCheck, "legacy-cli-sourced");
  assert.equal(calls, 2);
});

test("older Hermes CLI cannot complete a source-less research report", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  let calls = 0;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      calls++;
      if (calls === 1) {
        child.stderr.write("hermes: error: unrecognized arguments: --format stream-json\n");
        child.emit("close", 2);
      } else {
        child.stdout.write(JSON.stringify({ ...report(), sources: [] }));
        child.emit("close", 0);
      }
    });
    return child;
  };
  await assert.rejects(runHermesResearch({ mint: MINT, symbol: "DARK", pool: "pool" }, { root, spawnFn }), /legacy CLI returned no sources/);
  assert.equal(calls, 2);
});

test("older Hermes CLI reports unavailable web tools as a configuration error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  let calls = 0;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (++calls === 1) {
        child.stderr.write("hermes: error: unrecognized arguments: --format stream-json\n");
        child.emit("close", 2);
      } else {
        child.stdout.write("WEB_UNAVAILABLE\n\nsession_id: 20261010_173501_63825b\n");
        child.emit("close", 0);
      }
    });
    return child;
  };
  await assert.rejects(runHermesResearch({ mint: MINT, symbol: "DARK", pool: "pool" }, { root, spawnFn }), /Hermes web_search is unavailable in CLI mode/);
  assert.equal(calls, 2);
});

test("Hermes answer without a web search is retried instead of sent as a report", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "result", exit_code: 0, text: JSON.stringify({ ...report(), sources: [] }) }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
  await assert.rejects(runHermesResearch({ mint: MINT, symbol: "DARK", pool: "pool" }, { root, spawnFn }), /successful web_search/);
});

test("failed web_search result cannot become a completed research report", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-research-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enqueuePool(root, pool(MINT));
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "tool_result", name: "web_search", is_error: false, output: '{"success":false,"error":"provider key missing"}' }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", exit_code: 0, text: JSON.stringify({ ...report(), sources: [] }) }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
  await assert.rejects(runHermesResearch({ mint: MINT, symbol: "DARK", pool: "pool" }, { root, spawnFn }), /successful web_search/);
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
