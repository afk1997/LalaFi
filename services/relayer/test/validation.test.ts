import { describe, expect, it } from 'vitest';
import { P, Q, ZERO_ADDRESS } from '@xpool/service-common';
import { parseQuoteRequest, parseRelayRequest, type RelayRequest } from '../src/schema.js';
import { validateRelay } from '../src/validate.js';
import { makeExt, policy, wireRequest } from './fixtures.js';

function parsed(body: unknown): RelayRequest {
  const r = parseRelayRequest(body);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.value;
}

describe('relay request schema', () => {
  it('accepts a well-formed request and converts to bigint', () => {
    const req = parsed(wireRequest());
    expect(req.publicInputs.inputNullifiers[0]).toBe(P - 5n);
    expect(req.extData.dstChainId).toBe(31338n);
    expect(req.proof.b[1][0]).toBe(5n);
  });

  it('rejects unknown keys at every level', () => {
    const b = wireRequest() as Record<string, unknown>;
    expect(parseRelayRequest({ ...b, extra: 1 }).ok).toBe(false);
    const w = wireRequest();
    expect(parseRelayRequest({ ...w, extData: { ...w.extData, bridgeParams: {} } }).ok).toBe(false);
  });

  it('enforces field elements < P for public inputs and < Q for proof coordinates', () => {
    const w = wireRequest();
    const atP = { ...w, publicInputs: { ...w.publicInputs, root: P.toString() } };
    expect(parseRelayRequest(atP).ok).toBe(false);
    const belowP = { ...w, publicInputs: { ...w.publicInputs, root: (P - 1n).toString() } };
    expect(parseRelayRequest(belowP).ok).toBe(true);
    const atQ = { ...w, proof: { ...w.proof, a: [Q.toString(), '1'] } };
    expect(parseRelayRequest(atQ).ok).toBe(false);
    // P <= x < Q is a valid base-field coordinate
    const betweenPQ = { ...w, proof: { ...w.proof, a: [(P + 1n).toString(), '1'] } };
    expect(parseRelayRequest(betweenPQ).ok).toBe(true);
  });

  it('rejects malformed integers, addresses, bytes and oversized encOut', () => {
    const w = wireRequest();
    const bad = (patch: Record<string, unknown>) => parseRelayRequest({ ...w, extData: { ...w.extData, ...patch } }).ok;
    expect(bad({ withdrawAmount: '-1' })).toBe(false);
    expect(bad({ withdrawAmount: '1e6' })).toBe(false);
    expect(bad({ withdrawAmount: 1.5 })).toBe(false);
    expect(bad({ withdrawAmount: 2 ** 60 })).toBe(false); // unsafe JSON number
    expect(bad({ dstChainId: (1n << 64n).toString() })).toBe(false);
    expect(bad({ recipient: '0x1234' })).toBe(false);
    expect(bad({ encOut0: '0xabc' })).toBe(false);
    expect(bad({ encOut0: '0x' + 'ab'.repeat(256) })).toBe(true);
    expect(bad({ encOut0: '0x' + 'ab'.repeat(257) })).toBe(false);
  });

  it('error issues never echo submitted values', () => {
    const w = wireRequest();
    const r = parseRelayRequest({ ...w, extData: { ...w.extData, recipient: '0xSECRETVALUE' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).not.toContain('SECRETVALUE');
  });

  it('quote schema', () => {
    expect(parseQuoteRequest({ dstChainId: '31339', withdrawAmount: '1000000' }).ok).toBe(true);
    expect(parseQuoteRequest({ dstChainId: 31339, withdrawAmount: 1000000 }).ok).toBe(true);
    expect(parseQuoteRequest({ dstChainId: '31339' }).ok).toBe(false);
    expect(parseQuoteRequest({ dstChainId: '31339', withdrawAmount: '1', x: 1 }).ok).toBe(false);
  });
});

describe('semantic relay validation', () => {
  it('accepts a consistent request', () => {
    expect(validateRelay(parsed(wireRequest()), policy())).toBeNull();
  });

  it('accepts a transfer (no withdrawal)', () => {
    const ext = makeExt({ dstChainId: 0n, recipient: ZERO_ADDRESS, withdrawAmount: 0n, protocolFee: 0n });
    expect(validateRelay(parsed(wireRequest(ext)), policy())).toBeNull();
  });

  const cases: Array<[string, Parameters<typeof makeExt>[0], string]> = [
    ['version', { version: 2 }, 'bad_version'],
    ['hub chain', { hubChainId: 1n }, 'wrong_hub_chain'],
    ['hub', { hub: '0x9999999999999999999999999999999999999999' }, 'wrong_hub'],
    ['relayer', { relayer: '0x9999999999999999999999999999999999999999' }, 'wrong_relayer'],
    ['deadline', { deadline: 1_800_000_030n }, 'deadline_too_soon'],
    ['unsupported dst', { dstChainId: 10n }, 'unsupported_destination'],
    ['zero recipient', { recipient: ZERO_ADDRESS }, 'bad_withdraw_shape'],
    ['transfer with amount', { dstChainId: 0n, recipient: ZERO_ADDRESS, protocolFee: 0n }, 'bad_withdraw_shape'],
    ['min withdraw', { withdrawAmount: 999_999n, protocolFee: 1_000n }, 'below_min_withdraw'],
    ['protocol fee', { protocolFee: 4_999n }, 'bad_protocol_fee'],
    ['bucket', { relayerFee: 25_000n }, 'fee_not_bucketed'],
    ['fee below quote', { relayerFee: 10_000n }, 'fee_below_quote'],
  ];
  it.each(cases)('rejects %s', (_n, over, code) => {
    expect(validateRelay(parsed(wireRequest(makeExt(over))), policy())).toBe(code);
  });

  it('rejects inconsistent publicAmount and extDataHash (relayer cannot alter extData)', () => {
    const w = wireRequest();
    const tamperedFee = { ...w, extData: { ...w.extData, relayerFee: '30000' } };
    expect(validateRelay(parsed(tamperedFee), policy())).toBe('bad_public_amount');
    const tamperedRecipient = { ...w, extData: { ...w.extData, recipient: '0x4444444444444444444444444444444444444444' } };
    expect(validateRelay(parsed(tamperedRecipient), policy())).toBe('bad_ext_data_hash');
  });

  it('rejects duplicate nullifiers', () => {
    const w = wireRequest();
    const dup = { ...w, publicInputs: { ...w.publicInputs, inputNullifiers: ['42', '42'] } };
    expect(validateRelay(parsed(dup), policy())).toBe('duplicate_nullifier');
  });

  it('rejects v >= 2^248', () => {
    const big = 1n << 248n;
    const ext = makeExt({ withdrawAmount: big, protocolFee: (big * 10n + 9_999n) / 10_000n });
    expect(validateRelay(parsed(wireRequest(ext)), policy({ minAcceptableFee: 0n }))).toBe('amount_too_large');
  });
});
