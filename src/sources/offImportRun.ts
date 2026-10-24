/**
 * Runs one Open Food Facts import job and exits: `node offImportRun.js full|deltas`. Started by the server's scheduler
 * in a separate low-priority process, or by hand. Prints one JSON line per progress step and a final summary.
 */
import { loadConfig } from "../config.ts";
import { REPOSITORY_URL } from "../version.ts";
import { applyDeltas, fullImport, type ImportOptions } from "./offImport.ts";

const mode = process.argv[2];
const config = loadConfig();
const opts: ImportOptions = {
  dataDir: config.dataDir,
  userAgent: `${config.userAgent} (+${REPOSITORY_URL})`,
  onProgress: (products) => console.log(JSON.stringify({ progress: products })),
};

try {
  if (mode !== "full" && mode !== "deltas")
    throw new Error(`unknown job "${mode}" (expected full or deltas)`);
  const started = Date.now();
  const result = mode === "full" ? await fullImport(opts) : await applyDeltas(opts);
  console.log(
    JSON.stringify({ done: true, job: mode, seconds: Math.round((Date.now() - started) / 1000), ...result }),
  );
} catch (error) {
  console.log(
    JSON.stringify({ done: false, job: mode, error: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
}
