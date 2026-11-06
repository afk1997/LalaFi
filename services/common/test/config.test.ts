import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/index.js';

const root = join(import.meta.dirname, '../../..');
const localCfg = JSON.parse(readFileSync(join(root, 'config/local.json'), 'utf8'));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

const deployments = {
  environment: 'local',
  deployer: a(1),
  create3Factory: a(2),
  hub: {
    chainId: 31337,
    deployBlock: 0,
    usdc: a(10),
    contracts: {
      HubCore: a(11), DepositManager: a(12), StakeManager: a(13), LiquidityManager: a(14),
      Groth16Verifier: a(15), PoseidonT3: a(16), PoseidonT4: a(17), OpStackHubAdapter: a(18), ArbitrumHubAdapter: a(19),
    },
  },
  spokes: {
    '31338': { name: 'base', stack: 'opstack', deployBlock: 3, usdc: a(20), contracts: { Spoke: a(21) } },
    '31339': { name: 'arbitrum', stack: 'arbitrum', deployBlock: 4, usdc: a(30), contracts: { Spoke: a(31) } },
  },
  mocks: {
    '31337': {
      MockUSDC: a(10), MockL1CrossDomainMessenger: a(40), MockInbox: a(41), MockBridge: a(42), MockOutbox: a(43),
      MockTokenMessengerV2: a(44), MockMessageTransmitterV2: a(45),
    },
    '31338': { MockUSDC: a(20), MockL2CrossDomainMessenger: a(50), MockTokenMessengerV2: a(51), MockMessageTransmitterV2: a(52) },
    '31339': { MockUSDC: a(30), MockArbSys: '0x0000000000000000000000000000000000000064', MockTokenMessengerV2: a(61), MockMessageTransmitterV2: a(62) },
  },
};

describe('config resolution', () => {
  it('fills DEPLOYED_MOCK placeholders from deployments for local', () => {
    const cfg = resolveConfig(localCfg, deployments, root, { XPOOL_RPC_31339: 'http://anvil-arb:8545, http://other:8545' });
    expect(cfg.isLocal).toBe(true);
    expect(cfg.hub.usdc.toLowerCase()).toBe(a(10));
    expect(cfg.hub.cctp.messageTransmitterV2.toLowerCase()).toBe(a(45));
    const base = cfg.spokes.find((s) => s.chainId === 31338)!;
    expect(base.spoke.toLowerCase()).toBe(a(21));
    expect(base.hubAdapter.toLowerCase()).toBe(a(18));
    expect(base.l1.l1CrossDomainMessenger!.toLowerCase()).toBe(a(40));
    expect(base.l2.l2CrossDomainMessenger!.toLowerCase()).toBe(a(50));
    expect(base.deployBlock).toBe(3n);
    const arb = cfg.spokes.find((s) => s.chainId === 31339)!;
    expect(arb.hubAdapter.toLowerCase()).toBe(a(19));
    expect(arb.l1.inbox!.toLowerCase()).toBe(a(41));
    expect(arb.l1.outbox!.toLowerCase()).toBe(a(43));
    expect(arb.cctp.tokenMessengerV2.toLowerCase()).toBe(a(61));
    expect(arb.rpc).toEqual(['http://anvil-arb:8545', 'http://other:8545']);
    expect(cfg.params.k).toEqual([3n, 2n]);
    expect(cfg.params.relayerFeeBucket).toBe(10_000n);
    expect(cfg.mocks?.l1ToL2DelaySeconds).toBe(5);
  });

  it('fails loudly when a protocol address is missing', () => {
    const bad = structuredClone(deployments) as typeof deployments;
    delete (bad.hub.contracts as Record<string, string>).HubCore;
    expect(() => resolveConfig(localCfg, bad, root)).toThrow(/HubCore/);
  });
});
