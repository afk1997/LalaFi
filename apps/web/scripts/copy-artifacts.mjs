// Copies the committed circuit artifacts into public/circuits so the prover worker can fetch them.
// Their sha256 is checked in the browser against config/<env>.json before any proving.
import { copyFileSync, mkdirSync } from 'node:fs';
const src = new URL('../../../circuits/artifacts/', import.meta.url);
const dst = new URL('../public/circuits/', import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of ['transaction.wasm', 'transaction_final.zkey']) copyFileSync(new URL(f, src), new URL(f, dst));
console.log('circuit artifacts copied to public/circuits');
