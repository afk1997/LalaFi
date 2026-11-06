import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, keccak256, recoverTypedDataAddress, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  depositBatchDigest,
  depositBatchDigestManual,
  depositBatchTypedData,
  type DepositBatch,
  type Eip712Context,
} from '../src/index.js';

const ctx: Eip712Context = { hubChainId: 31337n, depositManager: '0x5FbDB2315678afecb367f032d93F642f64180aa3' };
const batch: DepositBatch = {
  srcChainId: 31338n,
  spoke: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  epoch: 12n,
  deposits: [
    { index: 0n, ownerDigest: 1n, amount: 1_000_000n, fee: 0n, l2Block: 10n },
    { index: 1n, ownerDigest: 2n, amount: 2_000_000n, fee: 0n, l2Block: 11n },
  ],
};

/** Written independently from the docs/IMPLEMENTATION.md layout, with no shared helpers. */
function handDigest(): `0x${string}` {
  const k = (s: string) => keccak256(stringToHex(s));
  const depType = 'L2Deposit(uint64 index,uint256 ownerDigest,uint256 amount,uint256 fee,uint64 l2Block)';
  const batchType = 'DepositBatch(uint64 srcChainId,address spoke,uint64 epoch,L2Deposit[] deposits)' + depType;
  const domainType = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
  const domainSep = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [k(domainType), k('xpool'), k('1'), 31337n, ctx.depositManager],
    ),
  );
  const depHashes = batch.deposits.map((d) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [k(depType), d.index, d.ownerDigest, d.amount, d.fee, d.l2Block],
      ),
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [k(batchType), batch.srcChainId, batch.spoke, batch.epoch, keccak256(concat(depHashes))],
    ),
  );
  return keccak256(concat(['0x1901', domainSep, structHash]));
}

describe('EIP-712 DepositBatch digest', () => {
  it('viem hashTypedData equals the hand-computed keccak per the docs layout', () => {
    expect(depositBatchDigest(ctx, batch)).toBe(handDigest());
  });

  it('explicit construction equals viem', () => {
    expect(depositBatchDigestManual(ctx, batch)).toBe(depositBatchDigest(ctx, batch));
  });

  it('pinned known-answer vector (guards against silent layout changes)', () => {
    expect(depositBatchDigest(ctx, batch)).toMatchInlineSnapshot(`"0xd4342607f110154e7a79dbe5b0748121019f45f35576866c00b1cc7f1607eb2e"`);
  });

  it('changes with any field, epoch, spoke, chain or domain', () => {
    const base = depositBatchDigest(ctx, batch);
    expect(depositBatchDigest({ ...ctx, hubChainId: 1n }, batch)).not.toBe(base);
    expect(depositBatchDigest(ctx, { ...batch, epoch: 13n })).not.toBe(base);
    expect(depositBatchDigest(ctx, { ...batch, deposits: [{ ...batch.deposits[0]!, fee: 1n }, batch.deposits[1]!] })).not.toBe(base);
  });

  it('signTypedData recovers to the signer', async () => {
    const acct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const td = depositBatchTypedData(ctx, batch);
    const sig = await acct.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(acct.address);
  });
});
