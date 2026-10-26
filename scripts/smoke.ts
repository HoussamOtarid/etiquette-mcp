/**
 * Live smoke test against the real sources (no MCP layer). Prints one line per case.
 * Usage: npm run smoke [-- [--check] <barcode or query> ...]
 * With --check it exits non-zero when a case is not found or a source answers with an error (site or parser broken);
 * timeouts and rate limits are reported but not failures.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NutritionService } from "../src/app/nutritionService.ts";
import { loadConfig } from "../src/config.ts";
import { Cache } from "../src/infra/cache.ts";
import { HealthTracker } from "../src/infra/health.ts";
import { HttpClient } from "../src/infra/http.ts";
import { createLogger } from "../src/infra/logger.ts";
import { createAdapters, DEFAULT_LIMIT, HOST_LIMITS } from "../src/sources/registry.ts";

const DEFAULT_CASES = [
  "3760109052641", // bread, sold in several shops
  "3760196070214", // cheese
  "5411788041157", // oat drink
  "3760324840986", // shop own-brand oat drink
  "3596710463411", // supermarket own brand (Chronodrive)
  "3270160596973", // Picard
  "muesli sportif supernature",
];

async function main(): Promise<void> {
  // The rate limiter's timers don't keep the process alive (the server's listener does); a script needs this.
  const keepAlive = setInterval(() => {}, 1000);
  const config = loadConfig({
    ...process.env,
    MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN ?? "smoke-test-token-not-used-for-anything",
    DATA_DIR: process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "etiquette-smoke-")),
    REQUEST_BUDGET_MS: process.env.REQUEST_BUDGET_MS ?? "45000",
    SOURCE_TIMEOUT_MS: process.env.SOURCE_TIMEOUT_MS ?? "30000",
  });
  const logger = createLogger(config.logLevel);
  const cache = new Cache(join(config.dataDir, "cache.db"));
  const http = new HttpClient({
    userAgent: config.userAgent,
    timeoutMs: 20_000,
    defaultLimit: DEFAULT_LIMIT,
    limits: HOST_LIMITS,
    logger,
  });
  const service = new NutritionService(createAdapters({ http, cache, logger, config }), {
    cache,
    health: new HealthTracker(),
    config,
    logger,
  });

  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const given = args.filter((a) => a !== "--check");
  const cases = given.length > 0 ? given : DEFAULT_CASES;
  const failures: string[] = [];
  const rows: string[] = [];
  for (const query of cases) {
    const started = Date.now();
    const r = await service.getLabel({ product: query, includeRaw: false });
    const n = r.label?.nutrients;
    const line = [
      query.padEnd(28),
      r.status.padEnd(9),
      (r.confidence?.overall ?? "-").padEnd(6),
      `labels=${r.confidence?.sources_with_label ?? 0}`,
      `kcal=${n?.energy_kcal?.value ?? "-"}(${n?.energy_kcal?.agreement ?? "-"})`,
      `offers=${(r.offers ?? []).map((o) => o.source).join(",") || "-"}`,
      `flags=${r.confidence?.flags.join(",") || "-"}`,
      `${Date.now() - started}ms`,
    ];
    console.log(line.join("  "));
    if (r.candidates)
      console.log(`   candidates: ${r.candidates.map((c) => `${c.name} [${c.brand ?? "?"}]`).join(" | ")}`);
    const failing = Object.entries(r.sources).filter(([, s]) => !["ok", "not_found", "skipped"].includes(s));
    if (failing.length) console.log(`   source issues: ${failing.map(([s, st]) => `${s}=${st}`).join(", ")}`);
    rows.push(
      `| ${query} | ${r.status} | ${r.confidence?.sources_with_label ?? 0} | ${failing.map(([s, st]) => `${s}=${st}`).join(", ") || "-"} | ${Date.now() - started} |`,
    );
    if (r.status !== "found") failures.push(`${query}: ${r.status}`);
    for (const [source, status] of failing)
      if (status === "error") failures.push(`${query}: ${source} error`);
  }
  writeSummary(rows, service.listSources(), failures);
  cache.close();
  clearInterval(keepAlive);
  if (check && failures.length > 0) {
    console.log(`\nFAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

/** On GitHub Actions, the results and each source's health (with its last error) go to the run's summary page. */
function writeSummary(
  rows: string[],
  sources: ReturnType<NutritionService["listSources"]>,
  failures: string[],
): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const health = sources.map(
    (s) =>
      `| ${s.source} | ${s.status} | ${s.calls_24h} | ${s.failures_24h} | ${s.last_failure?.replace(/\|/g, "/") ?? "-"} |`,
  );
  appendFileSync(
    path,
    [
      `## Live sources: ${failures.length > 0 ? `${failures.length} failure(s)` : "all good"}`,
      "",
      "| Case | Status | Labels | Source issues | ms |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      "| Source | Status | Calls | Failures | Last failure |",
      "|---|---|---|---|---|",
      ...health,
      "",
    ].join("\n"),
  );
}

await main();
