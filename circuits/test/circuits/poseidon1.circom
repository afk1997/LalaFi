pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";

// Test-only: exposes circomlib Poseidon(1) for cross-implementation vectors.
template PoseidonTest1() {
    signal input in[1];
    signal output out;
    component h = Poseidon(1);
    for (var i = 0; i < 1; i++) { h.inputs[i] <== in[i]; }
    out <== h.out;
}

component main = PoseidonTest1();
