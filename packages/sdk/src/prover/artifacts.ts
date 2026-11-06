/**
 * Circuit artifacts (docs/IMPLEMENTATION.md): circuits/artifacts/{transaction.wasm, transaction_final.zkey,
 * verification_key.json}; sha256 pins in config/<env>.json -> artifacts (or circuits/artifacts/hashes.json).
 * Artifacts are NEVER used unless their sha256 matches the pin.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactPins } from '../chains/config.js';

export interface ArtifactPaths {
  wasm: string;
  zkey: string;
  vkey: string;
}

export class ArtifactError extends Error {
  override name = 'ArtifactError';
}

export function defaultArtifactPaths(circuitsDir: string): ArtifactPaths {
  return {
    wasm: join(circuitsDir, 'artifacts', 'transaction.wasm'),
    zkey: join(circuitsDir, 'artifacts', 'transaction_final.zkey'),
    vkey: join(circuitsDir, 'artifacts', 'verification_key.json'),
  };
}

export function artifactsPresent(p: ArtifactPaths): boolean {
  return existsSync(p.wasm) && existsSync(p.zkey) && existsSync(p.vkey);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function normPin(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(?:sha256:)?([0-9a-fA-F]{64})$/.exec(v.trim());
  return m ? m[1]!.toLowerCase() : undefined;
}

/**
 * Read circuits/artifacts/hashes.json. Accepts keys wasm/zkey/vkey or the artifact file names,
 * values with or without a "sha256:" prefix.
 */
export function readHashesFile(path: string): ArtifactPins {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const flat: Record<string, unknown> = { ...raw, ...((raw.artifacts as Record<string, unknown>) ?? {}) };
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = normPin(flat[k]) ?? normPin((flat[k] as { sha256?: unknown } | undefined)?.sha256);
      if (v) return v;
    }
    return undefined;
  };
  return {
    wasm: pick('wasm', 'transaction.wasm'),
    zkey: pick('zkey', 'transaction_final.zkey'),
    vkey: pick('vkey', 'verification_key.json'),
  };
}

/** Throws unless every artifact exists and matches its pinned sha256. */
export async function verifyArtifacts(paths: ArtifactPaths, pins: ArtifactPins): Promise<void> {
  for (const k of ['wasm', 'zkey', 'vkey'] as const) {
    const want = pins[k];
    if (!want) throw new ArtifactError(`no pinned sha256 for ${k}; refusing to use unpinned circuit artifacts`);
    if (!existsSync(paths[k])) throw new ArtifactError(`missing artifact ${paths[k]}`);
    const got = await sha256File(paths[k]);
    if (got !== want) throw new ArtifactError(`sha256 mismatch for ${k}: expected ${want}, got ${got}`);
  }
}
