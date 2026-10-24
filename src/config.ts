import { z } from "zod";
import { SOURCE_IDS, type SourceId } from "./domain/types.ts";
import { VERSION } from "./version.ts";

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  MCP_AUTH_TOKEN: z.string().min(32, "MCP_AUTH_TOKEN must be at least 32 characters (openssl rand -hex 32)"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default("./data"),
  SOURCE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  REQUEST_BUDGET_MS: z.coerce.number().int().positive().default(20000),
  OFF_MAX_WAIT_MS: z.coerce.number().int().positive().default(120000),
  OFF_LOCAL_DB: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DISABLED_SOURCES: csv,
  USER_AGENT: z.string().default(`etiquette-mcp/${VERSION}`),
});

export interface Config {
  authToken: string;
  port: number;
  dataDir: string;
  sourceTimeoutMs: number;
  requestBudgetMs: number;
  /** How long a tool call may wait for queued Open Food Facts lookups. */
  offMaxWaitMs: number;
  /** Keep a local copy of Open Food Facts (several GB in DATA_DIR) and answer barcodes from it. */
  offLocalDb: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  disabledSources: SourceId[];
  userAgent: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const unknown = e.DISABLED_SOURCES.filter((s) => !(SOURCE_IDS as readonly string[]).includes(s));
  if (unknown.length > 0)
    throw new Error(`Invalid configuration: unknown DISABLED_SOURCES ${unknown.join(", ")}`);
  return {
    authToken: e.MCP_AUTH_TOKEN,
    port: e.PORT,
    dataDir: e.DATA_DIR,
    sourceTimeoutMs: e.SOURCE_TIMEOUT_MS,
    requestBudgetMs: e.REQUEST_BUDGET_MS,
    offMaxWaitMs: e.OFF_MAX_WAIT_MS,
    offLocalDb: e.OFF_LOCAL_DB === "true",
    logLevel: e.LOG_LEVEL,
    disabledSources: e.DISABLED_SOURCES as SourceId[],
    userAgent: e.USER_AGENT,
  };
}
