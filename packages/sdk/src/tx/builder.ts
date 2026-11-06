/**
 * Spend builders (PRD 6.4, 8.3): withdraw / partial / transfer / merge / fee-only.
 * Produces ExtData, PublicInputs and the witness input for the prover.
 */
import { encodeAbiParameters, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { shuffle } from '../crypto/random.js';
import type { SpendingKeys } from '../keys/derive.js';
import type { ShieldedAddress } from '../keys/address.js';
import type { OwnedNote } from '../notes/store.js';
import type { MerkleTree } from '../tree/merkle.js';
import type { PublicInputs, WitnessInput } from '../prover/types.js';
import { extDataHash, makeExtData, validateExtData, type ExtData } from './extdata.js';
import { isBucketMultiple, maxWithdrawable, protocolFee, publicAmount, totalOut } from './fees.js';
import { jitteredDeadline, type DeadlineOptions } from './deadline.js';
import {
  dummyInput, dummyOutput, noteOutput, realInput, selectInputs, SelectionError,
  type SpendInput, type SpendOutput,
} from './select.js';

export type SpendKind = 'withdraw' | 'partial' | 'transfer' | 'merge' | 'fee-only';

export interface SpendContext {
  keys: SpendingKeys;
  tree: MerkleTree;
  hubChainId: bigint;
  hub: Address;
  phiBps: bigint;
  relayerFeeBucket: bigint;
  /** minWithdraw per destination; a single value applies to all. */
  minWithdraw: bigint | ((dst: bigint) => bigint);
}

export interface FeeTerms {
  relayer: Address;
  relayerFee: bigint;
  deadline?: bigint;
  deadlineOptions?: DeadlineOptions;
}

export interface PreparedSpend {
  kind: SpendKind;
  extData: ExtData;
  publicInputs: PublicInputs;
  witness: WitnessInput;
  inputs: SpendInput[];
  outputs: SpendOutput[];
  /** v = w + relayerFee + protocolFee. */
  v: bigint;
  /** keccak256(abi.encode(n0, n1)). */
  spendId: Hex;
  /** Real (non-dummy) input notes consumed. */
  spentNotes: OwnedNote[];
}

export function spendIdOf(n0: bigint, n1: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [n0, n1]));
}

interface CoreRequest {
  kind: SpendKind;
  notes: OwnedNote[];
  withdraw?: { dstChainId: bigint; recipient: Address; amount: bigint };
  transfer?: { to: ShieldedAddress; amount: bigint };
  fees: FeeTerms;
}

const dec = (x: bigint | number): string => x.toString(10);

function minWithdrawFor(ctx: SpendContext, dst: bigint): bigint {
  return typeof ctx.minWithdraw === 'function' ? ctx.minWithdraw(dst) : ctx.minWithdraw;
}

/** Generic 2-in/2-out builder; the kind-specific helpers below choose amounts and inputs. */
export function buildSpend(ctx: SpendContext, req: CoreRequest): PreparedSpend {
  const { notes, fees } = req;
  if (notes.length < 1 || notes.length > 2) throw new SelectionError('a spend takes 1 or 2 input notes');
  if (new Set(notes.map((n) => n.leafIndex)).size !== notes.length) throw new SelectionError('duplicate input note');
  if (notes.some((n) => n.spent)) throw new SelectionError('input note already spent');
  if (!isBucketMultiple(fees.relayerFee, ctx.relayerFeeBucket)) throw new RangeError('relayerFee is not a multiple of the fee bucket');

  const w = req.withdraw?.amount ?? 0n;
  const dst = req.withdraw?.dstChainId ?? 0n;
  if (req.withdraw) {
    if (dst === 0n) throw new RangeError('withdrawal needs a destination chain');
    if (w <= 0n) throw new RangeError('withdraw amount must be > 0');
    if (w < minWithdrawFor(ctx, dst)) throw new RangeError('withdraw amount below minWithdraw');
  }
  const fProt = req.withdraw ? protocolFee(w, ctx.phiBps) : 0n;
  const v = totalOut(w, fees.relayerFee, fProt);
  const toRecipient = req.transfer?.amount ?? 0n;
  if (req.transfer && toRecipient <= 0n) throw new RangeError('transfer amount must be > 0');
  const sumIn = notes.reduce((s, n) => s + n.amount, 0n);
  const change = sumIn - v - toRecipient;
  if (change < 0n) throw new SelectionError('inputs do not cover amount + fees');

  // Inputs: real ones + fresh dummy padding, random order.
  const inputs: SpendInput[] = notes.map((n) => realInput(n, ctx.keys.sk, ctx.tree));
  while (inputs.length < 2) inputs.push(dummyInput());
  shuffle(inputs);
  if (inputs[0]!.nullifier === inputs[1]!.nullifier) throw new Error('duplicate nullifiers');

  // Outputs: recipient note, change to self (always encrypted to self), zero outputs as dummies.
  const outputs: SpendOutput[] = [];
  if (req.transfer) outputs.push(noteOutput('recipient', toRecipient, req.transfer.to.pk, req.transfer.to.encPk));
  if (change > 0n) outputs.push(noteOutput('change', change, ctx.keys.pk, ctx.keys.encPk));
  while (outputs.length < 2) outputs.push(dummyOutput());
  if (outputs.length > 2) throw new SelectionError('too many outputs');
  shuffle(outputs);

  const extData = makeExtData({
    hubChainId: ctx.hubChainId,
    hub: ctx.hub,
    dstChainId: dst,
    recipient: req.withdraw?.recipient ?? zeroAddress,
    withdrawAmount: w,
    relayer: fees.relayer,
    relayerFee: fees.relayerFee,
    protocolFee: fProt,
    deadline: fees.deadline ?? jitteredDeadline(fees.deadlineOptions),
    encOut0: toHex(outputs[0]!.encrypted),
    encOut1: toHex(outputs[1]!.encrypted),
  });
  validateExtData(extData);

  const root = ctx.tree.root();
  const pi: PublicInputs = {
    root,
    publicAmount: publicAmount(v),
    extDataHash: extDataHash(extData),
    inputNullifiers: [inputs[0]!.nullifier, inputs[1]!.nullifier],
    outputCommitments: [outputs[0]!.commitment, outputs[1]!.commitment],
  };

  const pair = <T>(f: (x: SpendInput) => T): [T, T] => [f(inputs[0]!), f(inputs[1]!)];
  const opair = <T>(f: (x: SpendOutput) => T): [T, T] => [f(outputs[0]!), f(outputs[1]!)];
  const witness: WitnessInput = {
    root: dec(pi.root),
    publicAmount: dec(pi.publicAmount),
    extDataHash: dec(pi.extDataHash),
    inputNullifier: [dec(pi.inputNullifiers[0]), dec(pi.inputNullifiers[1])],
    outputCommitment: [dec(pi.outputCommitments[0]), dec(pi.outputCommitments[1])],
    inAmount: pair((i) => dec(i.amount)),
    inSk: pair((i) => dec(i.sk)),
    inBlinding: pair((i) => dec(i.blinding)),
    inLeafIndex: pair((i) => dec(i.leafIndex)),
    inPathElements: pair((i) => i.pathElements.map(dec)),
    outAmount: opair((o) => dec(o.amount)),
    outPk: opair((o) => dec(o.pk)),
    outBlinding: opair((o) => dec(o.blinding)),
  };

  return {
    kind: req.kind,
    extData,
    publicInputs: pi,
    witness,
    inputs,
    outputs,
    v,
    spendId: spendIdOf(pi.inputNullifiers[0], pi.inputNullifiers[1]),
    spentNotes: [...notes],
  };
}

export interface WithdrawRequest {
  notes: readonly OwnedNote[];
  dstChainId: bigint;
  recipient: Address;
  /** w. Omit for a full withdrawal of the selected notes (`all`). */
  amount?: bigint;
  /** For a full withdrawal: which notes to empty (default: largest single note). */
  inputs?: OwnedNote[];
  fees: FeeTerms;
}

/** Withdraw w to (dst, recipient). Kind = 'withdraw' if no change remains, else 'partial'. */
export function buildWithdraw(ctx: SpendContext, r: WithdrawRequest): PreparedSpend {
  if (r.recipient === zeroAddress) throw new RangeError('recipient required');
  let inputs: OwnedNote[];
  let w: bigint;
  if (r.amount === undefined) {
    if (r.inputs) {
      inputs = r.inputs;
    } else {
      const largest = [...r.notes].filter((n) => !n.spent).sort((a, b) => (a.amount > b.amount ? -1 : 1))[0];
      if (!largest) throw new SelectionError('no unspent notes');
      inputs = [largest];
    }
    w = maxWithdrawable(inputs.reduce((s, n) => s + n.amount, 0n), r.fees.relayerFee, ctx.phiBps);
  } else {
    w = r.amount;
    inputs = r.inputs ?? selectInputs(r.notes, w + r.fees.relayerFee + protocolFee(w, ctx.phiBps));
  }
  const sumIn = inputs.reduce((s, n) => s + n.amount, 0n);
  const change = sumIn - w - r.fees.relayerFee - protocolFee(w, ctx.phiBps);
  return buildSpend(ctx, {
    kind: change === 0n ? 'withdraw' : 'partial',
    notes: inputs,
    withdraw: { dstChainId: r.dstChainId, recipient: r.recipient, amount: w },
    fees: r.fees,
  });
}

export interface TransferRequest {
  notes: readonly OwnedNote[];
  to: ShieldedAddress;
  amount: bigint;
  inputs?: OwnedNote[];
  fees: FeeTerms;
}

export function buildTransfer(ctx: SpendContext, r: TransferRequest): PreparedSpend {
  const inputs = r.inputs ?? selectInputs(r.notes, r.amount + r.fees.relayerFee);
  return buildSpend(ctx, { kind: 'transfer', notes: inputs, transfer: { to: r.to, amount: r.amount }, fees: r.fees });
}

/** Merge two notes into one (W6). */
export function buildMerge(ctx: SpendContext, notes: [OwnedNote, OwnedNote], fees: FeeTerms): PreparedSpend {
  return buildSpend(ctx, { kind: 'merge', notes, fees });
}

/** Pick the two smallest unspent notes for a merge. */
export function pickMergePair(notes: readonly OwnedNote[]): [OwnedNote, OwnedNote] | undefined {
  const s = notes.filter((n) => !n.spent && n.amount > 0n).sort((a, b) => (a.amount < b.amount ? -1 : 1));
  return s.length >= 2 ? [s[0]!, s[1]!] : undefined;
}

/** Pay a relayer and refresh a note: note(x) + dummy -> note(x - f_rel) + 0. */
export function buildFeeOnly(ctx: SpendContext, note: OwnedNote, fees: FeeTerms): PreparedSpend {
  return buildSpend(ctx, { kind: 'fee-only', notes: [note], fees });
}
