/**
 * The bound on scans running at once (#362). Each scan is a Chromium, and an assistant
 * issues tool calls in parallel.
 */

import { ScanLimiter, ScanQueueFullError } from '../../src/mcp/scan-limiter';

/** A task that runs until the test releases it. */
function heldTask() {
  let release!: (value: string) => void;
  let started = false;
  const done = new Promise<string>((resolve) => {
    release = resolve;
  });
  return {
    run: () => {
      started = true;
      return done;
    },
    release,
    hasStarted: () => started,
  };
}

/** Lets every already-queued microtask and timer callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ScanLimiter', () => {
  it('starts tasks up to the limit and holds the next until one finishes', async () => {
    const limiter = new ScanLimiter(2, 8);
    const [first, second, third] = [heldTask(), heldTask(), heldTask()];

    const results = [limiter.run(first.run), limiter.run(second.run), limiter.run(third.run)];
    await settle();

    expect([first.hasStarted(), second.hasStarted(), third.hasStarted()]).toEqual([
      true,
      true,
      false,
    ]);

    first.release('first');
    await settle();
    expect(third.hasStarted()).toBe(true);

    second.release('second');
    third.release('third');
    await expect(Promise.all(results)).resolves.toEqual(['first', 'second', 'third']);
  });

  it('starts waiting tasks in arrival order', async () => {
    const limiter = new ScanLimiter(1, 8);
    const running = heldTask();
    const order: string[] = [];

    const head = limiter.run(running.run);
    const queued = ['a', 'b', 'c'].map((name) =>
      limiter.run(async () => {
        order.push(name);
        return name;
      }),
    );
    running.release('head');

    await Promise.all([head, ...queued]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('refuses a task at once when the wait is full, and does not run it', async () => {
    const limiter = new ScanLimiter(1, 1);
    const [running, waiting, refused] = [heldTask(), heldTask(), heldTask()];

    const first = limiter.run(running.run);
    const second = limiter.run(waiting.run);

    await expect(limiter.run(refused.run)).rejects.toBeInstanceOf(ScanQueueFullError);
    expect(refused.hasStarted()).toBe(false);

    running.release('running');
    waiting.release('waiting');
    await expect(Promise.all([first, second])).resolves.toEqual(['running', 'waiting']);
  });

  it('frees the slot when a task fails, and passes the failure on', async () => {
    const limiter = new ScanLimiter(1, 8);
    const next = heldTask();

    const failed = limiter.run(() => Promise.reject(new Error('browser crashed')));
    const after = limiter.run(next.run);

    await expect(failed).rejects.toThrow('browser crashed');
    await settle();
    expect(next.hasStarted()).toBe(true);
    next.release('after');
    await expect(after).resolves.toBe('after');
  });

  it('keeps a new arrival out while a waiting task takes the freed slot', async () => {
    const limiter = new ScanLimiter(1, 8);
    const [first, second, late] = [heldTask(), heldTask(), heldTask()];

    const results = [limiter.run(first.run), limiter.run(second.run)];
    first.release('first');
    await settle();
    results.push(limiter.run(late.run));
    await settle();

    expect([second.hasStarted(), late.hasStarted()]).toEqual([true, false]);
    second.release('second');
    late.release('late');
    await expect(Promise.all(results)).resolves.toEqual(['first', 'second', 'late']);
  });

  it('never runs more than the limit, whatever the arrival pattern', async () => {
    const limiter = new ScanLimiter(2, 20);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await settle();
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
  });
});
