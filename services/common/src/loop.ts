import type { Logger } from './logger.js';
import { sleep } from './shutdown.js';

export interface LoopOptions {
  intervalMs: number;
  signal: AbortSignal;
  logger: Logger;
  /** Max backoff after consecutive failures. */
  maxBackoffMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Runs `tick` forever (until `signal` aborts), sleeping `intervalMs` between runs and backing
 * off exponentially on consecutive failures. Errors never escape.
 */
export async function runLoop(name: string, tick: () => Promise<void>, opts: LoopOptions): Promise<void> {
  const log = opts.logger.child({ loop: name });
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  let failures = 0;
  while (!opts.signal.aborted) {
    try {
      await tick();
      failures = 0;
    } catch (err) {
      failures++;
      log.warn('loop tick failed', { err, failures });
      opts.onError?.(err);
    }
    const wait = failures ? Math.min(maxBackoff, opts.intervalMs * 2 ** Math.min(failures, 10)) : opts.intervalMs;
    await sleep(wait, opts.signal);
  }
  log.debug('loop stopped');
}
