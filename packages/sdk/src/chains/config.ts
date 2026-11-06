/**
 * Node loader for config/<env>.json + deployments/<env>.json. Validation is in resolve.ts (browser-safe).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, ENVS, resolveEnv, type Env, type RawConfig, type RawDeployments, type ResolvedEnv } from './resolve.js';

export * from './resolve.js';

/** Locate a repo directory (`config` or `deployments`) by walking up from cwd and from this module. */
export function findRepoDir(name: 'config' | 'deployments', start: string = process.cwd()): string | undefined {
  const envVar = name === 'config' ? process.env.XPOOL_CONFIG_DIR : process.env.XPOOL_DEPLOYMENTS_DIR;
  if (envVar) return resolve(envVar);
  const starts = [resolve(start), dirname(fileURLToPath(import.meta.url))];
  for (const s of starts) {
    let d = s;
    for (;;) {
      if (existsSync(join(d, name)) && existsSync(join(d, 'pnpm-workspace.yaml'))) return join(d, name);
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return undefined;
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new ConfigError(`missing ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    throw new ConfigError(`cannot parse ${path}: ${(e as Error).message}`);
  }
}

export interface LoadOptions {
  configDir?: string;
  deploymentsDir?: string;
}

export function loadEnv(env: Env, opts: LoadOptions = {}): ResolvedEnv {
  if (!ENVS.includes(env)) throw new ConfigError(`unknown env ${env}`);
  const configDir = opts.configDir ?? findRepoDir('config');
  const deploymentsDir = opts.deploymentsDir ?? findRepoDir('deployments');
  if (!configDir) throw new ConfigError('cannot find config/ directory (set XPOOL_CONFIG_DIR)');
  if (!deploymentsDir) throw new ConfigError('cannot find deployments/ directory (set XPOOL_DEPLOYMENTS_DIR)');
  return resolveEnv(
    readJson<RawConfig>(join(configDir, `${env}.json`)),
    readJson<RawDeployments>(join(deploymentsDir, `${env}.json`)),
  );
}

