/**
 * Live smoke test against the real sources (no MCP layer). Prints one line per case.
 * Usage: npm run smoke [-- <barcode or query> ...]
 */
import { mkdtempSync } from "node:fs";
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
  "muesli sportif supernature",
];

async function main(): Promise<void> {
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

  const cases = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_CASES;
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
      `offers=${r.offers.map((o) => o.source).join(",") || "-"}`,
      `flags=${r.confidence?.flags.join(",") || "-"}`,
      `${Date.now() - started}ms`,
    ];
    console.log(line.join("  "));
    if (r.candidates)
      console.log(`   candidates: ${r.candidates.map((c) => `${c.name} [${c.brand ?? "?"}]`).join(" | ")}`);
    const failing = Object.entries(r.sources).filter(([, s]) => s !== "ok" && s !== "not_found");
    if (failing.length) console.log(`   source issues: ${failing.map(([s, st]) => `${s}=${st}`).join(", ")}`);
  }
  cache.close();
}

await main();
