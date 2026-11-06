import { recoverTypedDataAddress, type Hex } from 'viem';
import {
  HttpError,
  depositBatchDigest,
  depositBatchTypedData,
  type Eip712Context,
  type Logger,
  type Metrics,
  type ProtocolContext,
  type Route,
} from '@xpool/service-common';
import { assertBatchShape } from './attestation-signer.js';
import type { ChainView } from './chain-view.js';
import type { Equivocation, GossipStore } from './gossip-store.js';
import { parsePost, toWire, type Attestation } from './wire.js';

export type VerifyResult = { ok: true; digest: Hex } | { ok: false; reason: string };

/**
 * Accepts an attestation only if: the spoke matches the chain's configured spoke, the batch is
 * well-formed, the signature recovers to the claimed signer, and that signer is a registered
 * validator key on StakeManager. Jailed signers are still accepted (equivocation evidence).
 */
export class AttestationVerifier {
  constructor(
    private readonly ctx: ProtocolContext,
    private readonly eip: Eip712Context,
    private readonly view: ChainView,
  ) {}

  async verify(a: Attestation): Promise<VerifyResult> {
    const spoke = this.ctx.spokes.get(Number(a.batch.srcChainId));
    if (!spoke) return { ok: false, reason: 'unknown_chain' };
    if (spoke.cfg.spoke.toLowerCase() !== a.batch.spoke.toLowerCase()) return { ok: false, reason: 'wrong_spoke' };
    try {
      assertBatchShape(a.batch);
    } catch {
      return { ok: false, reason: 'bad_shape' };
    }
    const td = depositBatchTypedData(this.eip, a.batch);
    let recovered;
    try {
      recovered = await recoverTypedDataAddress({ ...td, signature: a.signature });
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
    if (recovered.toLowerCase() !== a.signer.toLowerCase()) return { ok: false, reason: 'bad_signature' };
    const info = await this.view.signerInfo(a.signer);
    if (!info.registered) return { ok: false, reason: 'unknown_signer' };
    return { ok: true, digest: depositBatchDigest(this.eip, a.batch) };
  }
}

export interface IngestDeps {
  verifier: AttestationVerifier;
  store: GossipStore;
  logger: Logger;
  onEquivocation: (e: Equivocation) => void;
  onNew?: (a: Attestation, digest: Hex) => void;
}

/** Verify + store a batch of attestations. Returns per-item outcome counts. */
export async function ingest(atts: Attestation[], deps: IngestDeps): Promise<{ accepted: number; duplicate: number; rejected: Record<string, number> }> {
  const res = { accepted: 0, duplicate: 0, rejected: {} as Record<string, number> };
  for (const a of atts) {
    const v = await deps.verifier.verify(a);
    if (!v.ok) {
      res.rejected[v.reason] = (res.rejected[v.reason] ?? 0) + 1;
      continue;
    }
    const { isNew, equivocations } = deps.store.add(a, v.digest);
    if (!isNew) {
      res.duplicate++;
      continue;
    }
    res.accepted++;
    for (const e of equivocations) {
      deps.logger.error('EQUIVOCATION detected', { signer: e.signer, chain: e.chainId, index: e.index });
      deps.onEquivocation(e);
    }
    deps.onNew?.(a, v.digest);
  }
  return res;
}

export function gossipRoutes(deps: IngestDeps & { ctx: ProtocolContext }): Route[] {
  return [
    {
      method: 'POST',
      path: '/v1/attestations',
      cost: 1,
      handler: async ({ body }) => {
        const atts = parsePost(body);
        if (!atts) throw new HttpError(400, 'invalid_attestation');
        return { body: await ingest(atts, deps) };
      },
    },
    {
      method: 'GET',
      path: '/v1/attestations',
      cost: 1,
      handler: async ({ query }) => {
        const chain = query.get('chain');
        const from = query.get('from') ?? '0';
        if (!chain || !/^\d{1,20}$/.test(chain) || !/^\d{1,20}$/.test(from)) throw new HttpError(400, 'invalid_query');
        if (!deps.ctx.spokes.has(Number(chain))) throw new HttpError(404, 'unknown_chain');
        return { body: { attestations: deps.store.list(BigInt(chain), BigInt(from)).map(toWire) } };
      },
    },
  ];
}

/** Pushes our attestations to peers and pulls theirs. Peers are untrusted: everything is re-verified. */
export class GossipClient {
  private readonly log: Logger;
  private readonly peerErrors;

  constructor(
    private readonly peers: string[],
    private readonly deps: IngestDeps,
    logger: Logger,
    metrics: Metrics,
    private readonly timeoutMs = 5_000,
  ) {
    this.log = logger.child({ component: 'gossip' });
    this.peerErrors = metrics.counter('validator_gossip_peer_errors_total', 'Gossip peer request failures', ['op']);
  }

  async push(atts: Attestation[]): Promise<void> {
    if (!atts.length) return;
    const body = JSON.stringify({ attestations: atts.slice(0, 64).map(toWire) });
    await Promise.all(
      this.peers.map(async (p) => {
        try {
          const r = await fetch(`${p}/v1/attestations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          if (!r.ok) throw new Error(`status ${r.status}`);
        } catch (err) {
          this.peerErrors.inc({ op: 'push' });
          this.log.debug('push failed', { peer: p, err });
        }
      }),
    );
  }

  async pull(chain: bigint, from: bigint): Promise<void> {
    await Promise.all(
      this.peers.map(async (p) => {
        try {
          const r = await fetch(`${p}/v1/attestations?chain=${chain}&from=${from}`, { signal: AbortSignal.timeout(this.timeoutMs) });
          if (!r.ok) throw new Error(`status ${r.status}`);
          const text = await r.text();
          if (text.length > 4 * 1024 * 1024) throw new Error('response too large');
          const parsed = JSON.parse(text) as { attestations?: unknown[] };
          const atts = (parsed.attestations ?? []).slice(0, 256).flatMap((x) => parsePost(x) ?? []);
          await ingest(atts, this.deps);
        } catch (err) {
          this.peerErrors.inc({ op: 'pull' });
          this.log.debug('pull failed', { peer: p, err });
        }
      }),
    );
  }
}
