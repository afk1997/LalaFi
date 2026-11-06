import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, keccak256, numberToHex, pad } from 'viem';
import { decodeCheckpoint, type L2Deposit } from '@xpool/service-common';
import { buildCheckpointPayload, checkpointReason, sameHeader, type CheckpointHeader } from '../src/payload.js';

const d = (i: number, amount = 1_000_000n): L2Deposit => ({ index: BigInt(i), ownerDigest: 100n + BigInt(i), amount, fee: 100_000n, l2Block: 500n + BigInt(i) });
const header: CheckpointHeader = { seq: 2n, from: 10n, to: 13n, countAtSend: 15n, l2Block: 600n };
const w = (x: bigint) => pad(numberToHex(x), { size: 32 });

describe('checkpoint payload reconstruction', () => {
  it('equals abi.encode(Checkpoint) built by hand from the event data', () => {
    // events arrive unordered, with extra deposits outside [from, to) and a duplicate
    const events = [d(12), d(9), d(10), d(13), d(11), d(10)];
    const { payload, checkpoint } = buildCheckpointPayload(header, events);
    const items = [d(10), d(11), d(12)];
    const expected = concat([
      w(0x20n), w(2n), w(10n), w(13n), w(15n), w(600n), w(0xc0n), w(3n),
      ...items.flatMap((x) => [w(x.index), w(x.ownerDigest), w(x.amount), w(x.fee), w(x.l2Block)]),
    ]);
    expect(payload).toBe(expected);
    expect(checkpoint.deposits.map((x) => x.index)).toEqual([10n, 11n, 12n]);
    // and matches viem's struct encoding the contract decodes with
    const viaViem = encodeAbiParameters(
      [{ type: 'tuple', components: [
        { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' },
        { type: 'tuple[]', components: [{ type: 'uint64' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }] },
      ] }],
      [[2n, 10n, 13n, 15n, 600n, items.map((x) => [x.index, x.ownerDigest, x.amount, x.fee, x.l2Block] as const)]],
    );
    expect(keccak256(payload)).toBe(keccak256(viaViem));
    expect(decodeCheckpoint(payload).countAtSend).toBe(15n);
  });

  it('handles empty checkpoints', () => {
    const { payload } = buildCheckpointPayload({ seq: 3n, from: 13n, to: 13n, countAtSend: 13n, l2Block: 700n }, [d(12)]);
    expect(decodeCheckpoint(payload).deposits).toEqual([]);
  });

  it('refuses incomplete or conflicting data instead of submitting a wrong payload', () => {
    expect(() => buildCheckpointPayload(header, [d(10), d(12)])).toThrow(/missing.*11/);
    expect(() => buildCheckpointPayload(header, [d(10), d(11), d(12), d(11, 5n)])).toThrow(/conflicting/);
  });

  it('compares headers field by field', () => {
    expect(sameHeader(header, { ...header })).toBe(true);
    expect(sameHeader(header, { ...header, l2Block: 1n })).toBe(false);
  });
});

describe('checkpoint send policy', () => {
  const base = { pending: 0n, lastSentSec: 1000, nowSec: 1100, everyN: 32n, everySec: 300, absenceNeeded: false };
  it('every N deposits', () => expect(checkpointReason({ ...base, pending: 32n })).toBe('count'));
  it('every T seconds when there is anything pending', () => {
    expect(checkpointReason({ ...base, pending: 1n })).toBeNull();
    expect(checkpointReason({ ...base, pending: 1n, nowSec: 1300 })).toBe('timer');
    expect(checkpointReason({ ...base, pending: 0n, nowSec: 99_999 })).toBeNull();
  });
  it('empty checkpoints only when an absence proof needs one', () => {
    expect(checkpointReason({ ...base, absenceNeeded: true })).toBe('absence');
  });
});
