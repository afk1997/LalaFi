/**
 * Tor transport (W8). Relayer calls, and RPC calls where possible, go through a SOCKS5 proxy
 * (default 127.0.0.1:9050) when it is reachable. Loopback URLs (local env) are always direct.
 */
import { connect } from 'node:net';
import { request as httpRequest, type Agent } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';

export const DEFAULT_TOR_HOST = '127.0.0.1';
export const DEFAULT_TOR_PORT = 9050;

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NetworkPolicy {
  /** Tor is in use for non-loopback hosts. */
  tor: boolean;
  /** Human-readable reason, for the loud warning when Tor is off. */
  reason: string;
  fetch: FetchFn;
}

/** True if a TCP connection to host:port succeeds within `timeoutMs`. */
export function isPortReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean): void => {
      s.removeAllListeners();
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export function isLoopbackUrl(u: string | URL): boolean {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

function headersToObject(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** fetch-compatible function over node:http(s) with a custom agent (e.g. SOCKS5). */
export function agentFetch(agent: Agent): FetchFn {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(await new Response(init.body).arrayBuffer());
    const req = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const r = req(url, { method, agent, headers: headersToObject(init.headers) }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers.set(k, v);
            else if (Array.isArray(v)) headers.set(k, v.join(', '));
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
        });
        res.on('error', reject);
      });
      r.on('error', reject);
      if (init.signal) {
        if (init.signal.aborted) r.destroy(new Error('aborted'));
        init.signal.addEventListener('abort', () => r.destroy(new Error('aborted')), { once: true });
      }
      r.setTimeout(60_000, () => r.destroy(new Error('request timeout')));
      if (body !== undefined) r.write(body);
      r.end();
    });
  };
}

/** Routes non-loopback requests through `torFetch`, loopback ones directly. */
export function routedFetch(torFetch: FetchFn): FetchFn {
  return (input, init) => {
    const u = input instanceof Request ? input.url : input.toString();
    return isLoopbackUrl(u) ? fetch(input, init) : torFetch(input, init);
  };
}

export interface TorOptions {
  /** `--no-tor`: user explicitly disabled Tor. */
  disabled?: boolean;
  host?: string;
  port?: number;
}

/** Decide the network policy: Tor on by default when reachable (W8). */
export async function resolveNetworkPolicy(opts: TorOptions = {}): Promise<NetworkPolicy> {
  if (opts.disabled) return { tor: false, reason: 'Tor disabled by --no-tor', fetch: globalThis.fetch.bind(globalThis) };
  const host = opts.host ?? DEFAULT_TOR_HOST;
  const port = opts.port ?? DEFAULT_TOR_PORT;
  if (!(await isPortReachable(host, port))) {
    return { tor: false, reason: `no Tor SOCKS5 proxy reachable at ${host}:${port}`, fetch: globalThis.fetch.bind(globalThis) };
  }
  // socks5h: DNS resolution happens inside Tor (no local DNS leak).
  const agent = new SocksProxyAgent(`socks5h://${host}:${port}`);
  return { tor: true, reason: `Tor via ${host}:${port}`, fetch: routedFetch(agentFetch(agent)) };
}

/** The loud W8 warning text. */
export function torWarning(policy: NetworkPolicy): string | undefined {
  if (policy.tor) return undefined;
  return [
    '!!! PRIVACY WARNING (W8): Tor is OFF !!!',
    `    ${policy.reason}.`,
    '    Relayer and RPC providers can see your IP address and link it to this spend.',
    '    Start Tor (SOCKS5 on 127.0.0.1:9050) to protect network metadata.',
  ].join('\n');
}
