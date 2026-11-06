import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { MAX_BATCH, type DepositBatch } from '@xpool/service-common';
import type { SignedAttestation } from './attestation-signer.js';

/** Gossip wire format (PRD 13.4): signature plus the full batch content. Integers as decimal strings. */

const uint = (bits: number) =>
  z
    .string()
    .regex(/^[0-9]{1,78}$/)
    .transform((v) => BigInt(v))
    .refine((v) => v < 1n << BigInt(bits), 'out of range');

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => getAddress(v.toLowerCase()) as Address);

export const wireAttestationSchema = z.strictObject({
  srcChainId: uint(64),
  spoke: address,
  epoch: uint(64),
  deposits: z
    .array(
      z.strictObject({ index: uint(64), ownerDigest: uint(256), amount: uint(256), fee: uint(256), l2Block: uint(64) }),
    )
    .min(1)
    .max(MAX_BATCH),
  signer: address,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((v) => v.toLowerCase() as Hex),
});

export const wirePostSchema = z.union([
  wireAttestationSchema,
  z.strictObject({ attestations: z.array(wireAttestationSchema).min(1).max(64) }),
]);

export interface Attestation {
  batch: DepositBatch;
  signer: Address;
  signature: Hex;
}

export function toWire(a: Attestation | SignedAttestation) {
  const s = (x: bigint) => x.toString();
  return {
    srcChainId: s(a.batch.srcChainId),
    spoke: a.batch.spoke,
    epoch: s(a.batch.epoch),
    deposits: a.batch.deposits.map((d) => ({ index: s(d.index), ownerDigest: s(d.ownerDigest), amount: s(d.amount), fee: s(d.fee), l2Block: s(d.l2Block) })),
    signer: a.signer,
    signature: a.signature,
  };
}

export function fromWire(w: z.infer<typeof wireAttestationSchema>): Attestation {
  return {
    batch: { srcChainId: w.srcChainId, spoke: w.spoke, epoch: w.epoch, deposits: w.deposits },
    signer: w.signer,
    signature: w.signature,
  };
}

export function parsePost(body: unknown): Attestation[] | null {
  const r = wirePostSchema.safeParse(body);
  if (!r.success) return null;
  return 'attestations' in r.data ? r.data.attestations.map(fromWire) : [fromWire(r.data)];
}
