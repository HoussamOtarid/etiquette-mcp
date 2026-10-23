import { join } from "node:path";
import { NutritionService } from "./app/nutritionService.ts";
import { loadConfig } from "./config.ts";
import { Cache } from "./infra/cache.ts";
import { HealthTracker } from "./infra/health.ts";
import { HttpClient } from "./infra/http.ts";
import { createLogger } from "./infra/logger.ts";
import { createHttpServer } from "./mcp/http.ts";
import { KazidomiAdapter } from "./sources/kazidomi.ts";
import { createAdapters, DEFAULT_LIMIT, HOST_LIMITS } from "./sources/registry.ts";

const PURGE_INTERVAL_MS = 3600_000;

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const cache = new Cache(join(config.dataDir, "cache.db"));
  const health = new HealthTracker();
  const http = new HttpClient({
    userAgent: config.userAgent,
    timeoutMs: config.sourceTimeoutMs * 2,
    defaultLimit: DEFAULT_LIMIT,
    limits: HOST_LIMITS,
    maxQueueWaitMs: config.requestBudgetMs * 2,
    logger,
  });
  const adapters = createAdapters({ http, cache, logger, config });
  const service = new NutritionService(adapters, { cache, health, config, logger });
  const server = createHttpServer({ service, authToken: config.authToken, logger });

  server.listen(config.port, "0.0.0.0", () => {
    logger.info("listening", { port: config.port, sources: adapters.map((a) => a.id) });
  });

  const kazidomi = adapters.find((a): a is KazidomiAdapter => a instanceof KazidomiAdapter);
  kazidomi
    ?.ensureIndex()
    .catch((error) => logger.warn("kazidomi index warm-up failed", { error: String(error) }));

  const purge = setInterval(() => {
    const removed = cache.purgeExpired();
    if (removed > 0) logger.info("cache purged", { removed });
  }, PURGE_INTERVAL_MS);
  purge.unref();

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => {
      cache.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
