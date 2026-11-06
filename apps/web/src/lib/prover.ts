import {
  publicSignals,
  toSolidityProof,
  type PublicInputs,
  type SnarkjsProof,
  type SolidityProof,
  type WitnessInput,
} from '@xpool/sdk/browser';

let worker: Worker | undefined;
let seq = 0;

function getWorker(): Worker {
  worker ??= new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

/** Proves in a Web Worker and checks the circuit's public signals equal the prepared public inputs. */
export function prove(witness: WitnessInput, pi: PublicInputs, pins: { wasm?: string; zkey?: string }): Promise<SolidityProof> {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', onMsg);
      if (!e.data.ok) return reject(new Error(e.data.error));
      const got = (e.data.publicSignals as string[]).map(BigInt);
      const want = publicSignals(pi);
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
        return reject(new Error('The proof does not match this withdrawal. Nothing was sent.'));
      }
      resolve(toSolidityProof(e.data.proof as SnarkjsProof));
    };
    w.addEventListener('message', onMsg);
    w.postMessage({
      id,
      witness,
      wasmUrl: '/circuits/transaction.wasm',
      zkeyUrl: '/circuits/transaction_final.zkey',
      pins,
    });
  });
}

/** Start downloading the ~12 MB proving key early (e.g. once a code is entered). */
export function warmProver(): void {
  getWorker();
  void fetch('/circuits/transaction_final.zkey', { priority: 'low' } as RequestInit).catch(() => undefined);
}
