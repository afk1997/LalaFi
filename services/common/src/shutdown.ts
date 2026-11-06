import type { Logger } from './logger.js';

export interface Shutdown {
  /** Aborted when shutdown starts; pass to loops and long waits. */
  signal: AbortSignal;
  /** Registered hooks run in reverse registration order. */
  onShutdown(fn: () => Promise<void> | void): void;
  trigger(reason: string): Promise<void>;
}

export function createShutdown(logger: Logger, opts: { timeoutMs?: number; exit?: boolean } = {}): Shutdown {
  const ac = new AbortController();
  const hooks: Array<() => Promise<void> | void> = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let running: Promise<void> | undefined;

  const trigger = (reason: string) => {
    if (running) return running;
    running = (async () => {
      logger.info('shutting down', { reason });
      ac.abort();
      const timer = setTimeout(() => {
        logger.error('shutdown timed out; forcing exit');
        if (opts.exit !== false) process.exit(1);
      }, timeoutMs);
      timer.unref();
      for (const fn of hooks.slice().reverse()) {
        try {
          await fn();
        } catch (err) {
          logger.error('shutdown hook failed', { err });
        }
      }
      clearTimeout(timer);
      logger.info('shutdown complete');
      if (opts.exit !== false) process.exit(0);
    })();
    return running;
  };

  if (opts.exit !== false) {
    process.once('SIGINT', () => void trigger('SIGINT'));
    process.once('SIGTERM', () => void trigger('SIGTERM'));
    process.on('unhandledRejection', (err) => {
      logger.error('unhandled rejection', { err });
      void trigger('unhandledRejection');
    });
  }

  return { signal: ac.signal, onShutdown: (fn) => hooks.push(fn), trigger };
}

/** Sleep that resolves early (without throwing) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
