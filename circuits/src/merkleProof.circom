pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/switcher.circom";

// Merkle root of `leaf` under the path `pathElements`, bottom-up (PRD 5.6):
//   h_0 = leaf
//   h_{l+1} = H2(h_l, s_l)  if bit_l(i) == 0
//           = H2(s_l, h_l)  if bit_l(i) == 1
//
// `pathIndices[l]` is bit l of the leaf index (LSB first). The caller derives the bits
// with Num2Bits(levels) of the leaf index; each bit is additionally constrained to be
// boolean here so the template is sound on its own (Switcher does not constrain `sel`).
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component switcher[levels];
    component hasher[levels];

    for (var l = 0; l < levels; l++) {
        pathIndices[l] * (pathIndices[l] - 1) === 0;

        switcher[l] = Switcher();
        switcher[l].L <== l == 0 ? leaf : hasher[l - 1].out;
        switcher[l].R <== pathElements[l];
        switcher[l].sel <== pathIndices[l];

        hasher[l] = Poseidon(2);
        hasher[l].inputs[0] <== switcher[l].outL;
        hasher[l].inputs[1] <== switcher[l].outR;
    }

    root <== hasher[levels - 1].out;
}
