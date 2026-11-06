/**
 * Password-encrypted JSON files: AES-256-GCM, key = scrypt(password, salt).
 * A {@link VaultKey} holds only the derived key (never the password) so a store can be re-saved
 * without re-running scrypt; every save uses a fresh 96-bit IV.
 * Writes are atomic (tmp + rename) and created with mode 0600.
 */
import { createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from '../crypto/random.js';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Default: N = 2^17, r = 8, p = 1 (~128 MiB). */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

interface Envelope {
  format: 'xpool-vault';
  v: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  ct: string;
}

export class VaultError extends Error {
  override name = 'VaultError';
}

const AAD = Buffer.from('xpool-vault/v1');
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const unhex = (s: string): Buffer => {
  if (typeof s !== 'string' || !/^([0-9a-f]{2})*$/.test(s)) throw new VaultError('corrupt vault encoding');
  return Buffer.from(s, 'hex');
};

function checkParams(k: ScryptParams): void {
  const ok =
    Number.isInteger(k.N) && k.N >= 2 ** 10 && k.N <= 2 ** 22 && (k.N & (k.N - 1)) === 0 &&
    Number.isInteger(k.r) && k.r >= 1 && k.r <= 32 && Number.isInteger(k.p) && k.p >= 1 && k.p <= 16;
  if (!ok) throw new VaultError('bad scrypt parameters');
}

/** A derived AES key bound to its scrypt salt/params. Call {@link VaultKey.destroy} when done. */
export class VaultKey {
  private constructor(
    private readonly key: Buffer,
    readonly salt: Uint8Array,
    readonly params: ScryptParams,
  ) {}

  static derive(password: string, salt: Uint8Array = randomBytes(16), params: ScryptParams = DEFAULT_SCRYPT): VaultKey {
    if (typeof password !== 'string' || password.length === 0) throw new VaultError('empty password');
    checkParams(params);
    const key = scryptSync(password.normalize('NFKC'), salt, 32, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 256 * params.N * params.r + 16 * 1024 * 1024,
    });
    return new VaultKey(key, Uint8Array.from(salt), { ...params });
  }

  /** Derive the key matching an existing vault file's header. */
  static forEnvelope(data: string, password: string): VaultKey {
    const env = parseEnvelope(data);
    return VaultKey.derive(password, unhex(env.kdf.salt), { N: env.kdf.N, r: env.kdf.r, p: env.kdf.p });
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(Buffer.from(stringifyTagged(value), 'utf8')), c.final()]);
    const env: Envelope = {
      format: 'xpool-vault',
      v: 1,
      kdf: { name: 'scrypt', N: this.params.N, r: this.params.r, p: this.params.p, salt: hex(this.salt) },
      cipher: 'aes-256-gcm',
      iv: hex(iv),
      tag: hex(c.getAuthTag()),
      ct: ct.toString('hex'),
    };
    return JSON.stringify(env);
  }

  decrypt<T>(data: string): T {
    const env = parseEnvelope(data);
    if (env.kdf.salt !== hex(this.salt)) throw new VaultError('vault key does not match this file');
    const iv = unhex(env.iv);
    const tag = unhex(env.tag);
    if (iv.length !== 12 || tag.length !== 16) throw new VaultError('corrupt vault header');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAAD(AAD);
      d.setAuthTag(tag);
      const pt = Buffer.concat([d.update(unhex(env.ct)), d.final()]);
      return parseTagged<T>(pt.toString('utf8'));
    } catch {
      throw new VaultError('wrong password or corrupted vault');
    }
  }

  destroy(): void {
    this.key.fill(0);
  }
}

/**
 * JSON codec that round-trips bigint and Uint8Array values:
 * bigint -> "$n:<decimal>", Uint8Array -> "$b:<hex>".
 */
export function stringifyTagged(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, _k: string, v: unknown) {
    if (typeof v === 'bigint') return `$n:${v.toString(10)}`;
    if (v instanceof Uint8Array) return `$b:${hex(v)}`;
    if (typeof v === 'string' && v.startsWith('$')) return `$s:${v}`;
    return v;
  });
}

export function parseTagged<T>(s: string): T {
  return JSON.parse(s, (_k, v: unknown) => {
    if (typeof v !== 'string' || !v.startsWith('$')) return v;
    if (v.startsWith('$n:')) return BigInt(v.slice(3));
    if (v.startsWith('$b:')) return new Uint8Array(unhex(v.slice(3)));
    if (v.startsWith('$s:')) return v.slice(3);
    return v;
  }) as T;
}

function parseEnvelope(data: string): Envelope {
  let env: Envelope;
  try {
    env = JSON.parse(data) as Envelope;
  } catch {
    throw new VaultError('vault file is not valid JSON');
  }
  if (env?.format !== 'xpool-vault' || env.v !== 1 || env.cipher !== 'aes-256-gcm' || env.kdf?.name !== 'scrypt') {
    throw new VaultError('unsupported vault format');
  }
  return env;
}

/** One-shot helpers. */
export function encryptJson(value: unknown, password: string, params: ScryptParams = DEFAULT_SCRYPT): string {
  const k = VaultKey.derive(password, randomBytes(16), params);
  try {
    return k.encrypt(value);
  } finally {
    k.destroy();
  }
}

export function decryptJson<T>(data: string, password: string): T {
  const k = VaultKey.forEnvelope(data, password);
  try {
    return k.decrypt<T>(data);
  } finally {
    k.destroy();
  }
}

/** Atomic write with 0600 permissions. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${hex(randomBytes(6))}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readVaultFile(path: string): string {
  if (!existsSync(path)) throw new VaultError(`no vault at ${path}`);
  return readFileSync(path, 'utf8');
}
