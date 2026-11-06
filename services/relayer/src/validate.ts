import type { Address } from 'viem';
import {
  AMOUNT_BOUND,
  EXT_DATA_VERSION,
  ZERO_ADDRESS,
  extDataHash,
  protocolFeeFor,
  publicAmountFor,
} from '@xpool/service-common';
import type { RelayRequest } from './schema.js';

/**
 * Semantic checks run before simulation. They mirror HubCore.transact (PRD 7.4) so obviously
 * bad requests never cost an eth_call, plus relayer-specific rules: the proof must pay THIS
 * relayer, at least the quoted fee, with enough deadline left to land.
 */

export interface RelayPolicy {
  hubChainId: bigint;
  hub: Address;
  relayer: Address;
  relayerFeeBucket: bigint;
  phiBps: bigint;
  /** Supported withdrawal destinations (hub + spokes) with their minWithdraw. */
  minWithdraw: Map<bigint, bigint>;
  nowSec: bigint;
  /** Spend must remain valid at least this long. */
  minDeadlineSec: bigint;
  /** Lowest fee this relayer accepts for this (dst, w). */
  minAcceptableFee: bigint;
}

export type RelayRejection =
  | 'bad_version'
  | 'wrong_hub_chain'
  | 'wrong_hub'
  | 'wrong_relayer'
  | 'deadline_too_soon'
  | 'bad_withdraw_shape'
  | 'unsupported_destination'
  | 'below_min_withdraw'
  | 'bad_protocol_fee'
  | 'fee_not_bucketed'
  | 'fee_below_quote'
  | 'amount_too_large'
  | 'bad_public_amount'
  | 'duplicate_nullifier'
  | 'bad_ext_data_hash';

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

export function validateRelay(req: RelayRequest, p: RelayPolicy): RelayRejection | null {
  const { extData: e, publicInputs: pi } = req;
  if (e.version !== EXT_DATA_VERSION) return 'bad_version';
  if (e.hubChainId !== p.hubChainId) return 'wrong_hub_chain';
  if (!same(e.hub, p.hub)) return 'wrong_hub';
  if (!same(e.relayer, p.relayer)) return 'wrong_relayer';
  if (e.deadline < p.nowSec + p.minDeadlineSec) return 'deadline_too_soon';

  if (e.dstChainId === 0n) {
    if (!same(e.recipient, ZERO_ADDRESS) || e.withdrawAmount !== 0n || e.protocolFee !== 0n) return 'bad_withdraw_shape';
  } else {
    const minW = p.minWithdraw.get(e.dstChainId);
    if (minW === undefined) return 'unsupported_destination';
    if (same(e.recipient, ZERO_ADDRESS) || e.withdrawAmount === 0n) return 'bad_withdraw_shape';
    if (e.withdrawAmount < minW) return 'below_min_withdraw';
    if (e.protocolFee !== protocolFeeFor(e.withdrawAmount, p.phiBps)) return 'bad_protocol_fee';
  }

  if (e.relayerFee % p.relayerFeeBucket !== 0n) return 'fee_not_bucketed';
  if (e.relayerFee < p.minAcceptableFee) return 'fee_below_quote';

  const v = e.withdrawAmount + e.relayerFee + e.protocolFee;
  if (v >= AMOUNT_BOUND) return 'amount_too_large';
  if (pi.publicAmount !== publicAmountFor(v)) return 'bad_public_amount';
  if (pi.inputNullifiers[0] === pi.inputNullifiers[1]) return 'duplicate_nullifier';
  if (pi.extDataHash !== extDataHash(e)) return 'bad_ext_data_hash';
  return null;
}
