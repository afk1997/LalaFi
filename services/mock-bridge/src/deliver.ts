import { numberToHex, parseEventLogs, type Hex } from 'viem';
import {
  applyL1ToL2Alias,
  mockMessengerAbi,
  mockOutboxAbi,
  simulateAndSend,
  type ChainClients,
  type XpoolConfig,
} from '@xpool/service-common';
import { arbTxGas, LOW_GAS, type Delivery } from './queue.js';

/** LOCAL ONLY. Executes one delivery against the mocks. Returns whether the target call succeeded. */

export interface DeliveryResult {
  tx: Hex;
  /** false = the delivered call failed (recorded failure / reverted retryable). */
  ok: boolean;
}

function mockAddr(cfg: XpoolConfig, chainId: number, name: string) {
  const a = cfg.mockContracts[String(chainId)]?.[name];
  if (!a) throw new Error(`deployments.mocks.${chainId}.${name} missing`);
  return a;
}

export async function deliver(cfg: XpoolConfig, chains: Map<number, ChainClients>, d: Delivery, lowGas: boolean): Promise<DeliveryResult> {
  const dst = chains.get(d.dstChainId);
  if (!dst?.wallet) throw new Error(`no wallet for chain ${d.dstChainId}`);

  switch (d.route) {
    case 'op-l1-to-l2':
    case 'op-l2-to-l1': {
      // The mock messenger sets xDomainMessageSender = sender and calls target with gasLimit;
      // a failing call is recorded as replayable instead of reverting.
      const messenger = mockAddr(cfg, d.dstChainId, d.route === 'op-l1-to-l2' ? 'MockL2CrossDomainMessenger' : 'MockL1CrossDomainMessenger');
      const { hash, receipt } = await simulateAndSend(dst.public, dst.wallet, {
        address: messenger,
        abi: mockMessengerAbi,
        functionName: 'relayMessage',
        args: [d.nonce, d.sender, d.target, d.message, lowGas ? LOW_GAS : d.gasLimit],
      });
      const failed = parseEventLogs({ abi: mockMessengerAbi, eventName: 'FailedRelayedMessage', logs: receipt.logs }).length > 0;
      return { tx: hash, ok: !failed };
    }
    case 'arb-l1-to-l2': {
      // Real authentication semantics: the call comes from the aliased L1 sender.
      const alias = applyL1ToL2Alias(d.from);
      const rpc = dst.public;
      await rpc.request({ method: 'anvil_impersonateAccount', params: [alias] } as never);
      try {
        await rpc.request({ method: 'anvil_setBalance', params: [alias, numberToHex(10n ** 20n)] } as never);
        const tx = (await rpc.request({
          method: 'eth_sendTransaction',
          params: [{ from: alias, to: d.to, data: d.data, value: numberToHex(d.l2CallValue), gas: numberToHex(arbTxGas(d.gasLimit, d.data, lowGas)) }],
        } as never)) as Hex;
        const receipt = await rpc.waitForTransactionReceipt({ hash: tx });
        return { tx, ok: receipt.status === 'success' };
      } finally {
        await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [alias] } as never);
      }
    }
    case 'arb-l2-to-l1': {
      const outbox = mockAddr(cfg, d.dstChainId, 'MockOutbox');
      const { hash } = await simulateAndSend(dst.public, dst.wallet, {
        address: outbox,
        abi: mockOutboxAbi,
        functionName: 'executeTransaction',
        args: [d.position, d.caller, d.destination, d.data],
      });
      return { tx: hash, ok: true };
    }
  }
}
