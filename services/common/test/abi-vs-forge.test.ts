/**
 * Every function / event / error in the services' hand-written ABIs must exist with the same
 * signature in the forge-compiled contracts (contracts/out). Skips if `forge build` hasn't run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Abi, AbiItem } from 'viem';
import { formatAbiItem } from 'viem/utils';
import { describe, expect, it } from 'vitest';
import * as abis from '../src/abis.js';

const out = join(__dirname, '..', '..', '..', 'contracts', 'out');
const forgeAbi = (c: string): Abi => JSON.parse(readFileSync(join(out, `${c}.sol`, `${c}.json`), 'utf8')).abi;
const sigs = (abi: Abi) =>
  new Set(
    (abi as readonly AbiItem[])
      .filter((i) => i.type === 'function' || i.type === 'event' || i.type === 'error')
      .map((i) => formatAbiItem(i as never)),
  );

const pairs: [keyof typeof abis, string][] = [
  ['hubCoreAbi', 'HubCore'],
  ['depositManagerAbi', 'DepositManager'],
  ['stakeManagerAbi', 'StakeManager'],
  ['liquidityManagerAbi', 'LiquidityManager'],
  ['hubAdapterAbi', 'OpStackHubAdapter'],
  ['hubAdapterAbi', 'ArbitrumHubAdapter'],
  ['spokeAbi', 'OpStackSpoke'],
  ['mockMessengerAbi', 'MockCrossDomainMessenger'],
  ['mockInboxAbi', 'MockInbox'],
  ['mockArbSysAbi', 'MockArbSys'],
  ['mockOutboxAbi', 'MockOutbox'],
  ['mockTokenMessengerAbi', 'MockTokenMessengerV2'],
  ['mockMessageTransmitterAbi', 'MockMessageTransmitterV2'],
];

// Errors may bubble up from callees (e.g. LiquidityManager / adapters through HubCore), so an error
// only has to exist in some protocol contract.
const allErrors = () =>
  new Set(
    pairs.flatMap(([, c]) =>
      (forgeAbi(c) as readonly AbiItem[]).filter((i) => i.type === 'error').map((i) => formatAbiItem(i as never)),
    ),
  );

describe.skipIf(!existsSync(join(out, 'HubCore.sol')))('service ABIs match forge artifacts', () => {
  for (const [name, contract] of pairs) {
    it(`${name} ⊆ ${contract}`, () => {
      const have = sigs(forgeAbi(contract));
      const errs = allErrors();
      const missing = [...sigs(abis[name] as Abi)].filter((s) => !have.has(s) && !errs.has(s));
      expect(missing).toEqual([]);
    });
  }
});
