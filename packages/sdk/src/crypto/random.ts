/**
 * CSPRNG only (PRD 5.10). Every random value in the SDK comes from here.
 */
// globalThis.crypto is the platform CSPRNG in Node >= 19 and every browser, so this module (and
// everything built on it) runs unchanged in the web app.
const webcrypto: typeof globalThis.crypto = globalThis.crypto;
if (!webcrypto?.getRandomValues) throw new Error('no CSPRNG available (globalThis.crypto.getRandomValues)');

const MAX_CHUNK = 65536; // getRandomValues limit per call

/** `n` bytes from the OS CSPRNG. */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('randomBytes: bad length');
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += MAX_CHUNK) {
    webcrypto.getRandomValues(out.subarray(off, Math.min(n, off + MAX_CHUNK)));
  }
  return out;
}

/** Uniform integer in [0, n) without modulo bias (rejection sampling). */
export function randomInt(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError('randomInt: bad bound');
  const limit = Math.floor(2 ** 32 / n) * n;
  for (;;) {
    const b = randomBytes(4);
    const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (v < limit) return v % n;
  }
}

/** Uniform float in [0, 1) with 53 bits of CSPRNG entropy. */
export function randomUnit(): number {
  const b = randomBytes(7);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return Number(v >> 3n) / 2 ** 53;
}

/** In-place Fisher-Yates shuffle with CSPRNG. Returns the same array. */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
