pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";

// Test-only: exposes circomlib Poseidon(3) for cross-implementation vectors.
template PoseidonTest3() {
    signal input in[3];
    signal output out;
    component h = Poseidon(3);
    for (var i = 0; i < 3; i++) { h.inputs[i] <== in[i]; }
    out <== h.out;
}

component main = PoseidonTest3();
