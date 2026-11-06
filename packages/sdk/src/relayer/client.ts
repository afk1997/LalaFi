/**
 * Relayer HTTP client (PRD 13.3):
 *   GET  /v1/info
 *   POST /v1/quote  {dstChainId, withdrawAmount}
 *   POST /v1/relay  {proof, publicInputs, extData}
 *   GET  /v1/status/:requestId
 * Wire format: uint256/uint64 as decimal strings, bytes as 0x-hex. Every response is validated.
 */
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import type { ExtData } from '../tx/extdata.js';
import type { SolidityProof, PublicInputs } from '../prover/types.js';
import type { FetchFn } from './tor.js';

export interface BridgeParams {
  maxSubmissionCost: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  refundAddress: Address;
}

export interface RelayerInfo {
  relayer: Address;
  chains: number[];
  feeBucket: bigint;
  version: string;
}

export interface RelayerQuote {
  relayer: Address;
  relayerFee: bigint;
  ethValue: bigint;
  bridgeParams: BridgeParams;
  expiresAt: number;
}

// services/relayer store.ts: pending | submitted | confirmed | released | failed
export type RelayState = 'pending' | 'submitted' | 'confirmed' | 'released' | 'failed' | string;

export interface RelayStatus {
  txHash?: Hex;
  state: RelayState;
  releaseIndex?: bigint;
}

export class RelayerError extends Error {
  override name = 'RelayerError';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const dec = (x: bigint): string => x.toString(10);

function big(v: unknown, what: string): bigint {
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new RelayerError(`relayer returned bad ${what}`);
}

function address(v: unknown, what: string): Address {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new RelayerError(`relayer returned bad ${what}`);
  return getAddress(v);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new RelayerError(`relayer returned bad ${what}`);
  return v as Record<string, unknown>;
}

export function serializeExtData(e: ExtData): Record<string, Json> {
  return {
    version: e.version,
    hubChainId: dec(e.hubChainId),
    hub: e.hub,
    dstChainId: dec(e.dstChainId),
    recipient: e.recipient,
    withdrawAmount: dec(e.withdrawAmount),
    relayer: e.relayer,
    relayerFee: dec(e.relayerFee),
    protocolFee: dec(e.protocolFee),
    deadline: dec(e.deadline),
    encOut0: e.encOut0,
    encOut1: e.encOut1,
  };
}

export function serializeProof(p: SolidityProof): Record<string, Json> {
  return {
    a: p.a.map(dec),
    b: p.b.map((r) => r.map(dec)),
    c: p.c.map(dec),
  };
}

export function serializePublicInputs(pi: PublicInputs): Record<string, Json> {
  return {
    root: dec(pi.root),
    publicAmount: dec(pi.publicAmount),
    extDataHash: dec(pi.extDataHash),
    inputNullifiers: pi.inputNullifiers.map(dec),
    outputCommitments: pi.outputCommitments.map(dec),
  };
}

export function parseQuote(raw: unknown): RelayerQuote {
  const q = obj(raw, 'quote');
  const bp = obj(q.bridgeParams ?? {}, 'bridgeParams');
  const expiresAt = Number(q.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new RelayerError('relayer returned bad expiresAt');
  return {
    relayer: address(q.relayer, 'relayer'),
    relayerFee: big(q.relayerFee, 'relayerFee'),
    ethValue: big(q.ethValue ?? '0', 'ethValue'),
    bridgeParams: {
      maxSubmissionCost: big(bp.maxSubmissionCost ?? '0', 'maxSubmissionCost'),
      gasLimit: big(bp.gasLimit ?? '0', 'gasLimit'),
      maxFeePerGas: big(bp.maxFeePerGas ?? '0', 'maxFeePerGas'),
      refundAddress: address(bp.refundAddress ?? '0x0000000000000000000000000000000000000000', 'refundAddress'),
    },
    expiresAt,
  };
}

export function parseInfo(raw: unknown): RelayerInfo {
  const i = obj(raw, 'info');
  const chains = Array.isArray(i.chains) ? i.chains.map((c) => Number(big(c, 'chain'))) : [];
  const buckets = i.feeBucket ?? i.feeBuckets ?? i.relayerFeeBucket;
  return {
    relayer: address(i.relayer, 'relayer'),
    chains,
    feeBucket: big(Array.isArray(buckets) ? buckets[0] : buckets ?? '0', 'feeBucket'),
    version: typeof i.version === 'string' ? i.version : String(i.version ?? ''),
  };
}

export function parseStatus(raw: unknown): RelayStatus {
  const s = obj(raw, 'status');
  if (typeof s.state !== 'string') throw new RelayerError('relayer returned bad state');
  const out: RelayStatus = { state: s.state };
  if (s.txHash != null) {
    if (typeof s.txHash !== 'string' || !isHex(s.txHash) || s.txHash.length !== 66) throw new RelayerError('bad txHash');
    out.txHash = s.txHash;
  }
  if (s.releaseIndex != null) out.releaseIndex = big(s.releaseIndex, 'releaseIndex');
  return out;
}

export interface RelayerClientOptions {
  baseUrl: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export class RelayerClient {
  private readonly base: string;
  private readonly f: FetchFn;
  private readonly timeoutMs: number;

  constructor(opts: RelayerClientOptions) {
    const u = new URL(opts.baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new RelayerError('relayer URL must be http(s)');
    this.base = u.toString().replace(/\/$/, '');
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async call(path: string, body?: Record<string, Json>): Promise<unknown> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new RelayerError(`relayer returned non-JSON (HTTP ${res.status})`, res.status);
      }
      if (!res.ok) {
        const msg = typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `HTTP ${res.status}`;
        throw new RelayerError(`relayer error: ${msg}`, res.status);
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  async info(): Promise<RelayerInfo> {
    return parseInfo(await this.call('/v1/info'));
  }

  async quote(dstChainId: bigint, withdrawAmount: bigint): Promise<RelayerQuote> {
    return parseQuote(await this.call('/v1/quote', { dstChainId: dec(dstChainId), withdrawAmount: dec(withdrawAmount) }));
  }

  async relay(proof: SolidityProof, publicInputs: PublicInputs, extData: ExtData): Promise<string> {
    const r = obj(
      await this.call('/v1/relay', {
        proof: serializeProof(proof),
        publicInputs: serializePublicInputs(publicInputs),
        extData: serializeExtData(extData),
      }),
      'relay response',
    );
    if (typeof r.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.requestId)) throw new RelayerError('bad requestId');
    return r.requestId;
  }

  async status(requestId: string): Promise<RelayStatus> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new RelayerError('bad requestId');
    return parseStatus(await this.call(`/v1/status/${requestId}`));
  }
}
