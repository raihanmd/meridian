import "../envcrypt.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jobPath } from "./queue.js";
import { runHermesResearch } from "./hermes.js";

const mint = process.argv[2];
const symbol = process.argv[3] || "?";

if (!mint) {
  console.error("Usage: bun run research:probe -- <MINT> [SYMBOL]");
  process.exitCode = 1;
} else {
  let root;
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-hermes-probe-"));
    await fs.mkdir(jobPath(root, mint));
    const report = await runHermesResearch({ mint, symbol, pool: "manual probe" }, { root });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`Hermes research probe failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
}
