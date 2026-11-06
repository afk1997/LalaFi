/**
 * Every function / event / error in the SDK's hand-written ABIs must exist with the same signature
 * in the compiled contracts (contracts/out, produced by `forge build`). Skips if not built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Abi, type AbiItem, formatAbiItem } from 'viem/utils';
import { describe, expect, it } from 'vitest';
import * as abis from '../src/abi/index.js';

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
  ['spokeAbi', 'OpStackSpoke'],
  ['liquidityManagerAbi', 'LiquidityManager'],
  ['stakeManagerAbi', 'StakeManager'],
];

describe.skipIf(!existsSync(join(out, 'HubCore.sol')))('SDK ABIs match forge artifacts', () => {
  for (const [name, contract] of pairs) {
    it(`${name} ⊆ ${contract}`, () => {
      const have = sigs(forgeAbi(contract));
      const missing = [...sigs(abis[name] as Abi)].filter((s) => !have.has(s));
      expect(missing).toEqual([]);
    });
  }
});
