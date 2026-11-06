import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { MAX_ENC_LEN, P, Q, type ExtData, type Proof, type PublicInputs } from '@xpool/service-common';

/**
 * Strict request schemas (PRD 13.3). Unknown keys are rejected. Integers travel as decimal or
 * 0x-hex strings (JSON numbers are accepted only when they are safe integers). Field elements
 * are range-checked: public inputs < P (scalar field), proof coordinates < Q (base field).
 */

const INT_RE = /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/;

const uintBelow = (bound: bigint, what: string) =>
  z
    .union([z.string().regex(INT_RE, `${what}: not an integer string`), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
    .transform((v) => BigInt(v))
    .refine((v) => v < bound, `${what}: out of range`);

const U64 = 1n << 64n;
const U256 = 1n << 256n;

const fieldP = uintBelow(P, 'field element');
const fieldQ = uintBelow(Q, 'proof coordinate');
const u64 = uintBelow(U64, 'uint64');
const u256 = uintBelow(U256, 'uint256');

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'address: expected 20-byte hex')
  .transform((v) => getAddress(v.toLowerCase()) as Address);

const encBytes = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, 'bytes: expected even-length hex')
  .refine((v) => (v.length - 2) / 2 <= MAX_ENC_LEN, `bytes: longer than ${MAX_ENC_LEN}`)
  .transform((v) => v.toLowerCase() as Hex);

export const proofSchema = z.strictObject({
  a: z.tuple([fieldQ, fieldQ]),
  b: z.tuple([z.tuple([fieldQ, fieldQ]), z.tuple([fieldQ, fieldQ])]),
  c: z.tuple([fieldQ, fieldQ]),
});

export const publicInputsSchema = z.strictObject({
  root: fieldP,
  publicAmount: fieldP,
  extDataHash: fieldP,
  inputNullifiers: z.tuple([fieldP, fieldP]),
  outputCommitments: z.tuple([fieldP, fieldP]),
});

export const extDataSchema = z.strictObject({
  version: z.number().int().min(0).max(0xffffffff),
  hubChainId: u64,
  hub: address,
  dstChainId: u64,
  recipient: address,
  withdrawAmount: u256,
  relayer: address,
  relayerFee: u256,
  protocolFee: u256,
  deadline: u64,
  encOut0: encBytes,
  encOut1: encBytes,
});

export const relayRequestSchema = z.strictObject({
  proof: proofSchema,
  publicInputs: publicInputsSchema,
  extData: extDataSchema,
});

export const quoteRequestSchema = z.strictObject({
  dstChainId: u64,
  withdrawAmount: u256,
});

export interface RelayRequest {
  proof: Proof;
  publicInputs: PublicInputs;
  extData: ExtData;
}

export interface QuoteRequest {
  dstChainId: bigint;
  withdrawAmount: bigint;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function parseWith<T>(schema: z.ZodType<T>, body: unknown): ParseResult<T> {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  // Issues name only paths and rule messages, never the submitted values.
  return { ok: false, issues: r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

export const parseRelayRequest = (body: unknown) => parseWith(relayRequestSchema, body) as ParseResult<RelayRequest>;
export const parseQuoteRequest = (body: unknown) => parseWith(quoteRequestSchema, body) as ParseResult<QuoteRequest>;
