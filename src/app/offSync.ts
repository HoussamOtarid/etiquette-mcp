import { fork } from "node:child_process";
import { setPriority } from "node:os";
import { dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Logger } from "../infra/logger.ts";
import { type OffLocalStore, removeStaleCopies } from "../sources/offLocal.ts";

export type OffJob = "full" | "deltas";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FULL_EVERY_MS = 30 * DAY;
/** Deltas cover the last 14 days; past that the copy must be rebuilt. */
const DELTAS_COVER_MS = 12 * DAY;
const DELTAS_EVERY_MS = 20 * HOUR;
const RETRY_AFTER_MS = 6 * HOUR;
const FIRST_CHECK_MS = 2 * 60_000;
const CHECK_EVERY_MS = 3 * HOUR;
/** Lowest CPU priority: tool calls always come first. */
const BACKGROUND_PRIORITY = 19;

/** Which job, if any, the local copy needs now. */
export function nextJob(
  now: number,
  copy: { fullImportAt: number | null; updatedAt: number | null },
  lastFailureAt: number | null,
): OffJob | null {
  if (lastFailureAt !== null && now - lastFailureAt < RETRY_AFTER_MS) return null;
  if (copy.fullImportAt === null || now - copy.fullImportAt > FULL_EVERY_MS) return "full";
  if (copy.updatedAt === null || now - copy.updatedAt > DELTAS_COVER_MS) return "full";
  if (now - copy.updatedAt > DELTAS_EVERY_MS) return "deltas";
  return null;
}

const here = fileURLToPath(import.meta.url);
const ENTRY = join(dirname(here), "..", "sources", `offImportRun${extname(here)}`);

/** Keeps the local Open Food Facts copy built and up to date, one job at a time, in a separate process. */
export class OffSync {
  private running = false;
  private lastFailureAt: number | null = null;
  private readonly store: OffLocalStore;
  private readonly dataDir: string;
  private readonly logger: Logger;

  constructor(store: OffLocalStore, deps: { dataDir: string; logger: Logger }) {
    this.store = store;
    this.dataDir = deps.dataDir;
    this.logger = deps.logger;
  }

  start(): void {
    const removed = removeStaleCopies(this.dataDir);
    if (removed.length > 0)
      this.logger.info("off local copy: removed stale files", { files: removed.length });
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref();
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  async check(): Promise<void> {
    if (this.running) return;
    const job = nextJob(Date.now(), this.store.times(), this.lastFailureAt);
    if (!job) return;
    this.running = true;
    try {
      const ok = await this.run(job);
      if (ok) {
        this.store.reopen();
        removeStaleCopies(this.dataDir);
        this.lastFailureAt = null;
      } else {
        this.lastFailureAt = Date.now();
      }
    } finally {
      this.running = false;
    }
  }

  private run(job: OffJob): Promise<boolean> {
    this.logger.info("off local copy: job started", { job });
    return new Promise((resolve) => {
      const child = fork(ENTRY, [job], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
      try {
        if (child.pid) setPriority(child.pid, BACKGROUND_PRIORITY);
      } catch {
        // Not permitted on some systems: the job then runs at normal priority.
      }
      if (child.stdout) {
        createInterface({ input: child.stdout }).on("line", (line) => {
          try {
            this.logger.info("off local copy", { job, ...(JSON.parse(line) as Record<string, unknown>) });
          } catch {
            this.logger.info("off local copy", { job, line });
          }
        });
      }
      child.on("error", (error) => {
        this.logger.warn("off local copy: job could not start", { job, error: String(error) });
        resolve(false);
      });
      child.on("exit", (code) => resolve(code === 0));
    });
  }
}
