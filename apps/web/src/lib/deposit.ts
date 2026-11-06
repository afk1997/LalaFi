/**
 * Deposit = the CLI's deposit (PRD 8.1 / 8.2), owned by a withdrawal code instead of a wallet:
 * fresh blinding b, P = H2(pk, b), note encrypted to the code's key, approve, deposit(a, P, encNote).
 */
import { abi, createNote, encryptNote, ownerDigest } from '@xpool/sdk/browser';
import { erc20Abi, toHex, type Abi, type Address, type Hash } from 'viem';
import { allowance, settleFee, waitForReceipt } from './chain';
import type { DepositCode } from './code';
import { chainOf } from './env';
import { write } from './wallet';

export type DepositStep = 'approve' | 'approving' | 'deposit' | 'depositing' | 'done';

export async function performDeposit(opts: {
  code: DepositCode;
  chainId: number;
  amount: bigint;
  owner: Address;
  onStep: (s: DepositStep, hash?: Hash) => void;
}): Promise<Hash> {
  const { code, chainId, amount, owner, onStep } = opts;
  const pool = code.pool;
  const c = chainOf(pool, chainId);
  const isHub = chainId === pool.env.hub.chainId;
  const note = createNote(amount, code.keys.pk);
  const P = ownerDigest(note.pk, note.blinding);
  const encNote = toHex(encryptNote(code.keys.encPk, { amount, blinding: note.blinding }));
  const total = amount + (isHub ? 0n : await settleFee(pool, chainId));

  // Approve exactly what this deposit pulls (no unlimited approvals).
  if ((await allowance(pool, chainId, c.token, owner, c.depositTo)) < total) {
    onStep('approve');
    const h = await write(chainId, c.token, erc20Abi as Abi, 'approve', [c.depositTo, total]);
    onStep('approving', h);
    await waitForReceipt(pool, chainId, h);
  }
  onStep('deposit');
  const depositAbi = (isHub ? abi.depositManagerAbi : abi.spokeAbi) as Abi;
  const h = await write(chainId, c.depositTo, depositAbi, 'deposit', [amount, P, encNote]);
  onStep('depositing', h);
  await waitForReceipt(pool, chainId, h);
  onStep('done', h);
  return h;
}
