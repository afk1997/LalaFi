pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";

// Test-only: exposes circomlib Poseidon(2) for cross-implementation vectors.
template PoseidonTest2() {
    signal input in[2];
    signal output out;
    component h = Poseidon(2);
    for (var i = 0; i < 2; i++) { h.inputs[i] <== in[i]; }
    out <== h.out;
}

component main = PoseidonTest2();
