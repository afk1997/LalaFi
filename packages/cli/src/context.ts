/**
 * Per-invocation context: global flags, resolved environment, network policy (Tor), clients.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createEnvClients, ENVS, findRepoDir, loadEnv, RelayerClient, resolveNetworkPolicy, torWarning,
  type EnvClients, type Env, type NetworkPolicy, type ResolvedEnv,
} from '@xpool/sdk';
import { CliError, info } from './io.js';

export interface GlobalOptions {
  env: string;
  home?: string;
  /** commander's --no-tor sets this to false. */
  tor: boolean;
  relayer?: string;
  configDir?: string;
  deploymentsDir?: string;
  circuitsDir?: string;
}

const DEFAULT_LOCAL_RELAYER = 'http://127.0.0.1:8090';

export class Ctx {
  readonly envName: Env;
  readonly home: string;
  private _env?: ResolvedEnv;
  private _net?: NetworkPolicy;
  private _clients?: EnvClients;

  constructor(readonly opts: GlobalOptions) {
    if (!(ENVS as readonly string[]).includes(opts.env)) throw new CliError(`--env must be one of ${ENVS.join('|')}`);
    this.envName = opts.env as Env;
    this.home = resolve(opts.home ?? process.env.XPOOL_HOME ?? join(homedir(), '.xpool'));
  }

  /** Wallet directory for this environment. */
  get walletDir(): string {
    return join(this.home, this.envName);
  }

  env(): ResolvedEnv {
    this._env ??= loadEnv(this.envName, { configDir: this.opts.configDir, deploymentsDir: this.opts.deploymentsDir });
    return this._env;
  }

  /** Tor on by default when reachable; loud warning otherwise (W8). */
  async network(): Promise<NetworkPolicy> {
    if (!this._net) {
      this._net = await resolveNetworkPolicy({ disabled: this.opts.tor === false });
      const w = torWarning(this._net);
      if (w && this.envName !== 'local') info(w);
      else if (w) info(`note: Tor is off (${this._net.reason}); fine for the local environment`);
    }
    return this._net;
  }

  async clients(): Promise<EnvClients> {
    if (!this._clients) {
      const net = await this.network();
      this._clients = createEnvClients(this.env(), net.tor ? net.fetch : undefined);
    }
    return this._clients;
  }

  async relayer(): Promise<RelayerClient> {
    const url = this.opts.relayer ?? process.env.XPOOL_RELAYER_URL ?? (this.envName === 'local' ? DEFAULT_LOCAL_RELAYER : undefined);
    if (!url) throw new CliError('no relayer configured: pass --relayer <url> or set XPOOL_RELAYER_URL');
    const net = await this.network();
    return new RelayerClient({ baseUrl: url, fetch: net.fetch });
  }

  circuitsDir(): string {
    const d = this.opts.circuitsDir ?? process.env.XPOOL_CIRCUITS_DIR;
    if (d) return resolve(d);
    const repoConfig = findRepoDir('config');
    if (!repoConfig) throw new CliError('cannot locate circuits/; pass --circuits-dir');
    return join(repoConfig, '..', 'circuits');
  }
}
