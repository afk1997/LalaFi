/**
 * W3: minimum delay since the funding deposits. Warn below 24 h, block below 1 h.
 */
import { OVERRIDE_FLAGS, type Finding } from './types.js';

export const DELAY_WARN_SECONDS = 24 * 3600;
export const DELAY_BLOCK_SECONDS = 3600;

function fmt(s: number): string {
  if (s < 3600) return `${Math.max(0, Math.floor(s / 60))} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function checkDelay(fundedAt: number, nowSec: number, override = false): Finding | undefined {
  const elapsed = nowSec - fundedAt;
  if (elapsed < DELAY_BLOCK_SECONDS) {
    return {
      rule: 'W3',
      level: override ? 'warn' : 'block',
      message: `funding deposit was only ${fmt(elapsed)} ago (minimum 1 h, recommended 24 h)`,
      overrideFlag: OVERRIDE_FLAGS.W3,
    };
  }
  if (elapsed < DELAY_WARN_SECONDS) {
    return { rule: 'W3', level: 'warn', message: `funding deposit was ${fmt(elapsed)} ago (recommended >= 24 h)` };
  }
  return undefined;
}

/** Seconds until the delay rule stops warning (0 if already fine). */
export function secondsUntilRecommended(fundedAt: number, nowSec: number): number {
  return Math.max(0, fundedAt + DELAY_WARN_SECONDS - nowSec);
}
