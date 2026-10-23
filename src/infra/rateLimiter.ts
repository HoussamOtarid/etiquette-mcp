export interface RateLimit {
  /** Minimum delay between the start of two requests. */
  intervalMs: number;
  /** Maximum requests in flight at once. */
  concurrency: number;
}

interface Job<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** FIFO limiter for one host: spaces request starts by `intervalMs` and caps concurrency. */
export class HostLimiter {
  private readonly queue: Array<Job<unknown>> = [];
  private active = 0;
  private nextStartAt = 0;
  private timer: NodeJS.Timeout | null = null;

  private readonly limit: RateLimit;

  constructor(limit: RateLimit) {
    this.limit = limit;
  }

  /** Rough time a new job would wait before starting. */
  estimatedWaitMs(now = Date.now()): number {
    const backlog = this.queue.length * this.limit.intervalMs;
    return Math.max(0, this.nextStartAt - now) + backlog;
  }

  schedule<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject } as Job<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.queue.length === 0 || this.active >= this.limit.concurrency) return;
    const wait = this.nextStartAt - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      this.timer.unref();
      return;
    }
    const job = this.queue.shift();
    if (!job) return;
    this.active++;
    this.nextStartAt = Date.now() + this.limit.intervalMs;
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--;
        this.pump();
      });
    this.pump();
  }
}
