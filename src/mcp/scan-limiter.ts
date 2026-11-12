/** Thrown by {@link ScanLimiter.run} when the task was refused; the task never started. */
export class ScanQueueFullError extends Error {
  constructor() {
    super('Too many scans are already running or waiting');
    this.name = 'ScanQueueFullError';
  }
}

/**
 * Runs at most `maxRunning` tasks at once; up to `maxWaiting` more wait in arrival order
 * (#362). Each MCP scan launches its own Chromium and an assistant issues tool calls in
 * parallel, so without a bound a dozen calls are a dozen browsers.
 */
export class ScanLimiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxRunning: number,
    private readonly maxWaiting: number,
  ) {}

  /** @throws ScanQueueFullError at once when `maxWaiting` tasks already wait. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.maxRunning) {
      this.running += 1;
    } else {
      if (this.waiting.length >= this.maxWaiting) throw new ScanQueueFullError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      // A waiting task takes this slot directly, so `running` never dips below the truth
      // and a new arrival cannot overtake the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
