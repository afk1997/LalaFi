import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, keccak256, numberToHex, pad, type Hex } from 'viem';
import {
  P,
  ceilDiv,
  decodeCheckpoint,
  decodeEnvelope,
  encodeCheckpoint,
  encodeReleaseMessage,
  extDataHash,
  itemHash,
  protocolFeeFor,
  publicAmountFor,
  receiveFromHubCalldata,
  roundUpToBucket,
  type Checkpoint,
  type ExtData,
  type L2Deposit,
} from '../src/index.js';

const word = (x: bigint | number) => pad(numberToHex(BigInt(x)), { size: 32 });

const deposits: L2Deposit[] = [
  { index: 7n, ownerDigest: 123456789n, amount: 1_000_000n, fee: 100_000n, l2Block: 4242n },
  { index: 8n, ownerDigest: P - 1n, amount: 2_500_000n, fee: 100_000n, l2Block: 4243n },
];

describe('checkpoint payload = abi.encode(Checkpoint)', () => {
  const cp: Checkpoint = { seq: 3n, from: 7n, to: 9n, countAtSend: 11n, l2Block: 4300n, deposits };

  it('matches the hand-built ABI layout word by word', () => {
    const depWords = deposits.flatMap((d) => [word(d.index), word(d.ownerDigest), word(d.amount), word(d.fee), word(d.l2Block)]);
    const expected = concat([
      word(0x20), // offset of the single dynamic tuple
      word(cp.seq),
      word(cp.from),
      word(cp.to),
      word(cp.countAtSend),
      word(cp.l2Block),
      word(6 * 32), // offset of deposits[] inside the tuple
      word(deposits.length),
      ...depWords,
    ]);
    expect(encodeCheckpoint(cp)).toBe(expected);
  });

  it('encodes an empty checkpoint', () => {
    const empty: Checkpoint = { seq: 4n, from: 9n, to: 9n, countAtSend: 9n, l2Block: 5000n, deposits: [] };
    expect(encodeCheckpoint(empty)).toBe(
      concat([word(0x20), word(4), word(9), word(9), word(9), word(5000), word(0xc0), word(0)]),
    );
  });

  it('round-trips', () => {
    const dec = decodeCheckpoint(encodeCheckpoint(cp));
    expect(dec.seq).toBe(3n);
    expect(dec.deposits).toEqual(deposits);
  });

  it('rejects payloads violating the receipt invariant', () => {
    expect(() => encodeCheckpoint({ ...cp, to: 10n })).toThrow(/length/);
    expect(() => encodeCheckpoint({ ...cp, from: 6n, to: 8n })).toThrow(/index/);
  });
});

describe('hashes', () => {
  it('itemHash = keccak256(abi.encode(L2Deposit)) (5 static words)', () => {
    const d = deposits[0]!;
    const expected = keccak256(concat([word(d.index), word(d.ownerDigest), word(d.amount), word(d.fee), word(d.l2Block)]));
    expect(itemHash(d)).toBe(expected);
  });

  it('extDataHash reduces keccak mod P', () => {
    const ext: ExtData = {
      version: 1,
      hubChainId: 31337n,
      hub: '0x1111111111111111111111111111111111111111',
      dstChainId: 31338n,
      recipient: '0x2222222222222222222222222222222222222222',
      withdrawAmount: 5_000_000n,
      relayer: '0x3333333333333333333333333333333333333333',
      relayerFee: 20_000n,
      protocolFee: 5_000n,
      deadline: 1_900_000_000n,
      encOut0: '0xabcd',
      encOut1: '0x',
    };
    const h = extDataHash(ext);
    expect(h < P).toBe(true);
    const raw = keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { type: 'uint32' }, { type: 'uint64' }, { type: 'address' }, { type: 'uint64' }, { type: 'address' },
              { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' },
              { type: 'bytes' }, { type: 'bytes' },
            ],
          },
        ],
        [[1, 31337n, ext.hub, 31338n, ext.recipient, 5_000_000n, ext.relayer, 20_000n, 5_000n, 1_900_000_000n, '0xabcd', '0x']],
      ),
    );
    expect(h).toBe(BigInt(raw) % P);
  });
});

describe('messages', () => {
  it('release envelope decodes to MSG_RELEASE and fixed calldata size', () => {
    const msg = encodeReleaseMessage({
      dstChainId: 31339n,
      index: 0n,
      recipient: '0x2222222222222222222222222222222222222222',
      amount: 1n,
      spendId: ('0x' + '00'.repeat(32)) as Hex,
    });
    expect(decodeEnvelope(msg).kind).toBe(1);
    // 4 selector + offset + length + 256-byte envelope
    expect((receiveFromHubCalldata(msg).length - 2) / 2).toBe(4 + 32 + 32 + 256);
  });
});

describe('fee math', () => {
  it('ceilDiv / protocol fee / bucket rounding', () => {
    expect(ceilDiv(0n, 7n)).toBe(0n);
    expect(ceilDiv(14n, 7n)).toBe(2n);
    expect(ceilDiv(15n, 7n)).toBe(3n);
    expect(protocolFeeFor(1_000_000n, 10n)).toBe(1_000n);
    expect(protocolFeeFor(1_000_001n, 10n)).toBe(1_001n);
    expect(roundUpToBucket(1n, 10_000n)).toBe(10_000n);
    expect(roundUpToBucket(10_000n, 10_000n)).toBe(10_000n);
    expect(roundUpToBucket(10_001n, 10_000n)).toBe(20_000n);
    expect(publicAmountFor(0n)).toBe(0n);
    expect(publicAmountFor(5n)).toBe(P - 5n);
  });
});
