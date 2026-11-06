import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deriveKeys, encodeAddress, mnemonicToSeed, freshWithdrawalAddress } from '@xpool/sdk';
import { Wallet } from '../src/wallet.js';
import { Ctx } from '../src/context.js';
import { parseAllocations } from '../src/commands/operator.js';
import { parseUsdc, fmtUsdc, CliError } from '../src/io.js';
import { checkRelayFlags } from '../src/ops/spend.js';

const PKG = resolve(__dirname, '..');
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const PASSWORD = 'correct horse battery';

function xpool(args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, ['--conditions=xpool-source', '--import', 'tsx', 'src/index.ts', ...args], {
    cwd: PKG,
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...process.env, XPOOL_PASSWORD: PASSWORD, ...opts.env },
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('xpool CLI (subprocess)', () => {
  it('init shows the mnemonic once on stderr, stores everything encrypted, prints the address', () => {
    const home = mkdtempSync(join(tmpdir(), 'xpool-cli-'));
    const r = xpool(['--home', home, 'init']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^lxpool1[02-9ac-hj-np-z]+$/);
    const words = r.stderr.split('\n').find((l) => l.trim().split(' ').length === 24)!;
    expect(words).toBeDefined();
    expect(r.stdout).not.toContain(words.split(' ')[0]! + ' ' + words.split(' ')[1]!);
    for (const f of allFiles(home)) {
      const raw = readFileSync(f, 'utf8');
      expect(raw).not.toContain(words.trim());
      expect(raw).not.toContain(words.trim().split(' ').slice(0, 2).join(' '));
      expect(statSync(f).mode & 0o077).toBe(0);
    }
    // address is stable and needs the password
    const a = xpool(['--home', home, 'address']);
    expect(a.stdout.trim()).toBe(r.stdout.trim());
    const bad = xpool(['--home', home, 'address'], { env: { XPOOL_PASSWORD: 'wrong password' } });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/wrong password/);
    // refuses to overwrite
    expect(xpool(['--home', home, 'init']).code).not.toBe(0);
  });

  it('init --import reads the mnemonic from stdin and derives the expected address', () => {
    const home = mkdtempSync(join(tmpdir(), 'xpool-cli-'));
    const r = xpool(['--home', home, '--env', 'testnet', 'init', '--import'], { input: `${TEST_MNEMONIC}\n` });
    expect(r.code, r.stderr).toBe(0);
    const k = deriveKeys(mnemonicToSeed(TEST_MNEMONIC), 0);
    expect(r.stdout.trim()).toBe(encodeAddress('txpool', k.pk, k.encPk));
    expect(r.stderr).not.toContain('RECOVERY PHRASE');
    expect(r.stderr).not.toContain('abandon');
    const bal = xpool(['--home', home, '--env', 'testnet', 'balance']);
    expect(bal.stdout.trim()).toBe('0 USDC');
  });

  it('enforces W1: --self-relay requires --i-understand-linkability', () => {
    const home = mkdtempSync(join(tmpdir(), 'xpool-cli-'));
    const r = xpool(['--home', home, 'withdraw', '--to-chain', 'base', '--amount', '10', '--self-relay']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/W1/);
    expect(r.stderr).toMatch(/--i-understand-linkability/);
  });

  it('rejects addresses for another network', () => {
    const home = mkdtempSync(join(tmpdir(), 'xpool-cli-'));
    const k = deriveKeys(mnemonicToSeed(TEST_MNEMONIC), 0);
    const r = xpool(['--home', home, 'transfer', '--to', encodeAddress('xpool', k.pk, k.encPk), '--amount', '1']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/wrong network/);
  });

  it('lists every PRD 13.2 command', () => {
    const r = xpool(['--help']);
    for (const c of ['init', 'address', 'sync', 'balance', 'notes', 'deposit', 'transfer', 'withdraw', 'merge', 'status', 'privacy', 'lp', 'validator']) {
      expect(r.stdout).toContain(c);
    }
    expect(r.stdout).toContain('--no-tor');
    const w = xpool(['withdraw', '--help']).stdout;
    for (const f of ['--to-chain', '--recipient', '--fresh', '--split', '--self-relay', '--i-understand-linkability', '--ignore-delay', '--ignore-anonymity', '--allow-linked-recipient']) {
      expect(w).toContain(f);
    }
    const v = xpool(['validator', '--help']).stdout;
    for (const c of ['register', 'bond', 'allocate', 'unbond', 'withdraw', 'claim']) expect(v).toContain(c);
  });
});

describe('wallet internals', () => {
  const FAST = { N: 2 ** 10, r: 8, p: 1 };

  it('fresh recipients follow m/44\'/60\'/7331\'/0/n and are never reused across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xpool-w-'));
    const w = Wallet.create(dir, 'pw-12345678', 'local', TEST_MNEMONIC, '', 0, FAST);
    const seed = mnemonicToSeed(TEST_MNEMONIC);
    expect(w.reserveFreshRecipient()).toEqual({ address: freshWithdrawalAddress(seed, 0), index: 0 });
    w.addLinkedAddress('0xAbC0000000000000000000000000000000000001');
    w.addLinkedAddress('0xabc0000000000000000000000000000000000001');
    w.save();
    w.close();
    const r = Wallet.open(dir, 'pw-12345678');
    expect(r.reserveFreshRecipient().index).toBe(1);
    expect(r.data.linkedAddresses).toHaveLength(1);
    r.close();
  });

  it('parses amounts and allocations', () => {
    expect(parseUsdc('1000')).toBe(1_000_000_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(() => parseUsdc('1.0000001')).toThrow(CliError);
    expect(() => parseUsdc('0')).toThrow(CliError);
    expect(() => parseUsdc('-1')).toThrow(CliError);
    expect(fmtUsdc(1_500_000n)).toBe('1.5 USDC');

    const dep = mkdtempSync(join(tmpdir(), 'xpool-dep-'));
    const a = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
    writeFileSync(join(dep, 'local.json'), JSON.stringify({
      environment: 'local',
      hub: { chainId: 31337, deployBlock: 0, usdc: a(1), contracts: { HubCore: a(2), DepositManager: a(3), StakeManager: a(4), LiquidityManager: a(5) } },
      spokes: {
        '31338': { name: 'base', stack: 'opstack', deployBlock: 0, usdc: a(6), contracts: { Spoke: a(8) } },
        '31339': { name: 'arbitrum', stack: 'arbitrum', deployBlock: 0, usdc: a(9), contracts: { Spoke: a(10) } },
      },
    }));
    const ctx = new Ctx({ env: 'local', tor: false, deploymentsDir: dep, home: dep });
    expect(parseAllocations(ctx, 'base=100, arb=50')).toEqual({ chainIds: [31338n, 31339n], amounts: [100_000_000n, 50_000_000n] });
    expect(() => parseAllocations(ctx, 'base=1,base=2')).toThrow(/duplicate/);
    expect(() => parseAllocations(ctx, 'sol=1')).toThrow();
    expect(() => checkRelayFlags({ selfRelay: true })).toThrow(/W1/);
    expect(() => checkRelayFlags({ selfRelay: true, iUnderstandLinkability: true })).not.toThrow();
  });
});
