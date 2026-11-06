import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, recoverAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KvStore, applyL1ToL2Alias, openDatabase, undoL1ToL2Alias, type XpoolConfig } from '@xpool/service-common';
import { attest, decodeMockMessage, irisResponse, IrisStore } from '../src/cctp.js';
import { DelayQueue, FailureInjector, arbTxGas, retryDelayMs, type Scheduled } from '../src/queue.js';
import { opDestination } from '../src/watchers.js';

// Anvil account 1 (mock relayer + attester)
const ATTESTER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

describe('Arbitrum alias for impersonated L1→L2 delivery', () => {
  it('matches AddressAliasHelper (known vectors)', () => {
    // L1 address + 0x1111000000000000000000000000000000001111 (mod 2^160)
    expect(applyL1ToL2Alias('0x5FbDB2315678afecb367f032d93F642f64180aa3').toLowerCase()).toBe('0x70ceb2315678afecb367f032d93f642f64181bb4');
    expect(applyL1ToL2Alias('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee').toLowerCase()).toBe('0xffffeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeffff');
    // wraps around 2^160
    expect(applyL1ToL2Alias('0xffffffffffffffffffffffffffffffffffffffff').toLowerCase()).toBe('0x1111000000000000000000000000000000001110');
    const a = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as Address;
    expect(undoL1ToL2Alias(applyL1ToL2Alias(a))).toBe(a);
  });
});

describe('delay queue and failure injection', () => {
  const item = (key: string, dueAt: number): Scheduled => ({
    key,
    dueAt,
    attempts: 0,
    lowGas: false,
    delivery: { route: 'arb-l2-to-l1', dstChainId: 31337, position: 0n, caller: '0x0000000000000000000000000000000000000001', destination: '0x0000000000000000000000000000000000000002', data: '0x' },
  });

  it('releases items only when due, in order, without duplicates', () => {
    const q = new DelayQueue();
    q.add(item('b', 200));
    q.add(item('a', 100));
    q.add(item('a', 100));
    expect(q.takeDue(50)).toEqual([]);
    expect(q.takeDue(150).map((i) => i.key)).toEqual(['a']);
    expect(q.size).toBe(1);
    expect(q.takeDue(1000).map((i) => i.key)).toEqual(['b']);
  });

  it('fails exactly the next N deliveries of a route', () => {
    const f = new FailureInjector('op-l1-to-l2:2');
    expect(f.consume('arb-l1-to-l2')).toBe(false);
    expect([f.consume('op-l1-to-l2'), f.consume('op-l1-to-l2'), f.consume('op-l1-to-l2')]).toEqual([true, true, false]);
    f.set('arb-l1-to-l2', 1);
    expect(f.snapshot()).toEqual({ 'op-l1-to-l2': 0, 'arb-l1-to-l2': 1 });
    expect(() => new FailureInjector('bogus:1')).toThrow();
  });

  it('arbitrum tx gas = intrinsic + ticket gas (low gas cannot complete)', () => {
    expect(arbTxGas(300_000n, '0xabcd', false)).toBe(21_000n + 32n + 300_000n);
    expect(arbTxGas(300_000n, '0xabcd', true)).toBe(21_000n + 32n + 5_000n);
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(20)).toBe(60_000);
  });
});

describe('mock CCTP attester + Iris', () => {
  const message = encodeAbiParameters(
    [{ type: 'uint64' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
    [7n, 0, 6, `0x${'00'.repeat(12)}${'ab'.repeat(20)}`, 50_000_000n, 0n],
  );

  it('decodes the mock message format', () => {
    expect(decodeMockMessage(message)).toMatchObject({ nonce: 7n, srcDomain: 0, dstDomain: 6, amount: 50_000_000n, maxFee: 0n });
  });

  it('attestation is a raw 65-byte signature over keccak256(message) by the attester (no EIP-191)', async () => {
    const sig = await attest(ATTESTER, message);
    expect((sig.length - 2) / 2).toBe(65);
    expect(await recoverAddress({ hash: keccak256(message), signature: sig })).toBe(ATTESTER.address);
  });

  it('serves Iris-shaped responses: 404, pending, complete', async () => {
    const store = new IrisStore(new KvStore(openDatabase(':memory:')));
    const tx = `0x${'cd'.repeat(32)}` as const;
    expect(irisResponse(store.get(0, tx), 0).status).toBe(404);
    store.add(0, tx, { message, attestation: await attest(ATTESTER, message), eventNonce: '7', readyAt: 1000 });
    store.add(0, tx, { message, attestation: '0x00', eventNonce: '7', readyAt: 1000 }); // dedup by message
    const pending = irisResponse(store.get(0, tx), 999).body as { messages: Array<{ status: string; attestation: string }> };
    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0]).toMatchObject({ status: 'pending_confirmations', attestation: 'PENDING' });
    const done = irisResponse(store.get(0, tx.toUpperCase().replace('0X', '0x') as `0x${string}`), 1000).body as { messages: Array<{ status: string; message: string }> };
    expect(done.messages[0]).toMatchObject({ status: 'complete', message });
  });
});

describe('OP message routing', () => {
  const cfg = {
    spokes: [
      { chainId: 31338, stack: 'opstack', spoke: '0x00000000000000000000000000000000000000aa' },
      { chainId: 31339, stack: 'arbitrum', spoke: '0x00000000000000000000000000000000000000bb' },
    ],
  } as unknown as XpoolConfig;
  it('delivers to the OP spoke (by target, or the only one)', () => {
    expect(opDestination(cfg, '0x00000000000000000000000000000000000000AA')).toBe(31338);
    expect(opDestination(cfg, '0x00000000000000000000000000000000000000cc')).toBe(31338);
  });
});
