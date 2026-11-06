// Flattens fixtures/circuit-poseidon-vectors.json into per-input columns that forge's JSON
// cheatcodes can read in O(1) calls. Output: fixtures/poseidon-columns.json (checked for drift by
// packages/sdk/test/cross-impl.test.ts).
import { readFileSync, writeFileSync } from 'node:fs';
const v = JSON.parse(readFileSync(new URL('../fixtures/circuit-poseidon-vectors.json', import.meta.url)));
const out = {};
for (const h of ['H1', 'H2', 'H3']) {
  const n = v[h][0].inputs.length;
  out[h] = { output: v[h].map((e) => e.output) };
  for (let i = 0; i < n; i++) out[h][`in${i}`] = v[h].map((e) => e.inputs[i]);
}
writeFileSync(new URL('../fixtures/poseidon-columns.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
