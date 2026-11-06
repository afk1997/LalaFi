/**
 * Poseidon H1/H2/H3 as in circomlib (PRD 5.2), via poseidon-lite.
 * Inputs MUST be field elements; we reject out-of-range values instead of silently reducing.
 */
import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { assertField, type Field } from './field.js';

export function H1(x: Field): Field {
  return poseidon1([assertField(x, 'H1 input')]);
}

export function H2(x: Field, y: Field): Field {
  return poseidon2([assertField(x, 'H2 input 0'), assertField(y, 'H2 input 1')]);
}

export function H3(x: Field, y: Field, z: Field): Field {
  return poseidon3([assertField(x, 'H3 input 0'), assertField(y, 'H3 input 1'), assertField(z, 'H3 input 2')]);
}
