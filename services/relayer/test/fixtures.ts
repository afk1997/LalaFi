import { P, extDataHash, protocolFeeFor, publicAmountFor, type ExtData } from '@xpool/service-common';
import type { Address } from 'viem';
import type { RelayPolicy } from '../src/validate.js';

export const HUB: Address = '0x1111111111111111111111111111111111111111';
export const RELAYER: Address = '0x3333333333333333333333333333333333333333';
export const NOW = 1_800_000_000n;

export function makeExt(over: Partial<ExtData> = {}): ExtData {
  const w = over.withdrawAmount ?? 5_000_000n;
  return {
    version: 1,
    hubChainId: 31337n,
    hub: HUB,
    dstChainId: 31338n,
    recipient: '0x2222222222222222222222222222222222222222',
    withdrawAmount: w,
    relayer: RELAYER,
    relayerFee: 20_000n,
    protocolFee: protocolFeeFor(w, 10n),
    deadline: NOW + 3600n,
    encOut0: '0xabcd',
    encOut1: '0x',
    ...over,
  };
}

/** Wire-format (JSON) relay body whose publicAmount / extDataHash are consistent with ext. */
export function wireRequest(ext: ExtData = makeExt()) {
  const v = ext.withdrawAmount + ext.relayerFee + ext.protocolFee;
  const s = (x: bigint) => x.toString();
  return {
    proof: { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] },
    publicInputs: {
      root: '123',
      publicAmount: s(publicAmountFor(v)),
      extDataHash: s(extDataHash(ext)),
      inputNullifiers: ['0x' + (P - 5n).toString(16), '42'],
      outputCommitments: ['9', '10'],
    },
    extData: {
      version: ext.version,
      hubChainId: s(ext.hubChainId),
      hub: ext.hub,
      dstChainId: s(ext.dstChainId),
      recipient: ext.recipient,
      withdrawAmount: s(ext.withdrawAmount),
      relayer: ext.relayer,
      relayerFee: s(ext.relayerFee),
      protocolFee: s(ext.protocolFee),
      deadline: s(ext.deadline),
      encOut0: ext.encOut0,
      encOut1: ext.encOut1,
    },
  };
}

export function policy(over: Partial<RelayPolicy> = {}): RelayPolicy {
  return {
    hubChainId: 31337n,
    hub: HUB,
    relayer: RELAYER,
    relayerFeeBucket: 10_000n,
    phiBps: 10n,
    minWithdraw: new Map([
      [31337n, 1_000_000n],
      [31338n, 1_000_000n],
      [31339n, 1_000_000n],
    ]),
    nowSec: NOW,
    minDeadlineSec: 60n,
    minAcceptableFee: 20_000n,
    ...over,
  };
}
