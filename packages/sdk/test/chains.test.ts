import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEnv, resolveEnv, chainIdFor, chainName, ConfigError, findRepoDir, type RawConfig, type RawDeployments } from '../src/chains/config.js';
import { createEnvClients, RpcPool, chainDef } from '../src/chains/clients.js';
import { hubCoreAbi, depositManagerAbi, spokeAbi, stakeManagerAbi, liquidityManagerAbi } from '../src/abi/index.js';
import { getAbiItem, toEventSelector, toFunctionSelector } from 'viem';

const REPO_CONFIG = resolve(__dirname, '../../../config');
const a = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

function deployments(): RawDeployments {
  return {
    environment: 'local',
    hub: {
      chainId: 31337, deployBlock: 0, usdc: a(1),
      contracts: { HubCore: a(2), DepositManager: a(3), StakeManager: a(4), LiquidityManager: a(5) },
    },
    spokes: {
      '31338': { name: 'base', stack: 'opstack', deployBlock: 7, usdc: a(6), contracts: { Spoke: a(8) } },
      '31339': { name: 'arbitrum', stack: 'arbitrum', deployBlock: 0, usdc: a(9), contracts: { Spoke: a(10) } },
    },
  };
}

describe('config loader', () => {
  const cfg = JSON.parse(readFileSync(join(REPO_CONFIG, 'local.json'), 'utf8')) as RawConfig;

  it('resolves the real local config with DEPLOYED_MOCK addresses from deployments', () => {
    const env = resolveEnv(cfg, deployments());
    expect(env.hrp).toBe('lxpool');
    expect(env.hub.usdc.toLowerCase()).toBe(a(1));
    expect(env.spokes[0]!.usdc.toLowerCase()).toBe(a(6));
    expect(env.spokes[0]!.deployBlock).toBe(7n);
    expect(env.params.phiBps).toBe(10n);
    expect(env.params.relayerFeeBucket).toBe(10_000n);
    expect(env.artifacts.wasm).toBe("341fb9b77d0746b7916e3a31e0e49b7eb81c3f66ba7d8e4be82294bb6b5d0628");
    expect(chainIdFor(env, 'eth')).toBe(31337);
    expect(chainIdFor(env, 'base')).toBe(31338);
    expect(chainIdFor(env, 'arb')).toBe(31339);
    expect(chainName(env, 31339)).toBe('arb');
    expect(() => chainIdFor(env, 'sol')).toThrow(ConfigError);
  });

  it('validates addresses and environment consistency', () => {
    const d = deployments();
    d.hub.contracts.HubCore = '0x1234';
    expect(() => resolveEnv(cfg, d)).toThrow(/HubCore/);
    expect(() => resolveEnv(cfg, { ...deployments(), environment: 'testnet' })).toThrow(/mismatch/);
    const d2 = deployments();
    delete (d2.spokes as Record<string, unknown>)['31339'];
    expect(() => resolveEnv(cfg, d2)).toThrow(/31339/);
  });

  it('loads from directories and finds the repo config dir', () => {
    const dep = mkdtempSync(join(tmpdir(), 'xpool-dep-'));
    writeFileSync(join(dep, 'local.json'), JSON.stringify(deployments()));
    const env = loadEnv('local', { configDir: REPO_CONFIG, deploymentsDir: dep });
    expect(env.spokes).toHaveLength(2);
    expect(findRepoDir('config')).toBe(REPO_CONFIG);
    const empty = mkdtempSync(join(tmpdir(), 'xpool-dep-'));
    mkdirSync(join(empty, 'x'));
    expect(() => loadEnv('local', { configDir: REPO_CONFIG, deploymentsDir: empty })).toThrow(ConfigError);
  });

  it('creates per-RPC client pools that rotate', () => {
    const env = resolveEnv(cfg, deployments());
    const c = createEnvClients(env);
    expect(c.pool(31338)).toBe(c.spokes.get(31338));
    const pool = new RpcPool(chainDef(1, 'x', ['http://127.0.0.1:1', 'http://127.0.0.1:2']), ['http://127.0.0.1:1', 'http://127.0.0.1:2']);
    const first = pool.pick();
    expect(pool.pick()).not.toBe(first);
    expect(pool.pick()).toBe(first);
  });
});

describe('ABIs match the Solidity interfaces', () => {
  it('event and function signatures', () => {
    expect(toEventSelector(getAbiItem({ abi: hubCoreAbi, name: 'NewCommitment' }))).toBe(toEventSelector('NewCommitment(uint256,uint32,bytes)'));
    expect(toEventSelector(getAbiItem({ abi: depositManagerAbi, name: 'L2DepositInserted' }))).toBe(toEventSelector('L2DepositInserted(uint64,uint64,uint256,uint32,bool)'));
    expect(toEventSelector(getAbiItem({ abi: spokeAbi, name: 'Deposit' }))).toBe(toEventSelector('Deposit(uint64,uint256,uint256,uint256,uint64,bytes)'));
    expect(toFunctionSelector(getAbiItem({ abi: hubCoreAbi, name: 'transact' }))).toBe(
      toFunctionSelector(
        'transact((uint256[2],uint256[2][2],uint256[2]),(uint256,uint256,uint256,uint256[2],uint256[2]),(uint32,uint64,address,uint64,address,uint256,address,uint256,uint256,uint64,bytes,bytes),(uint256,uint256,uint256,address))',
      ),
    );
    expect(toFunctionSelector(getAbiItem({ abi: stakeManagerAbi, name: 'setAllocations' }))).toBe(toFunctionSelector('setAllocations(uint64[],uint256[])'));
    expect(toFunctionSelector(getAbiItem({ abi: liquidityManagerAbi, name: 'addLiquidity' }))).toBe(toFunctionSelector('addLiquidity(uint256,address)'));
  });
});
