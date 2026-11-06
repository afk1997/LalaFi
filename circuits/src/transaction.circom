pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./merkleProof.circom";

// xpool v1 spend circuit (PRD 6). Adapted from Tornado Nova's transaction.circom to the
// note format of PRD 5.4/5.5, with range checks on inputs as well as outputs.
//
// Notes (PRD 5.4):  pk = H1(sk),  P = H2(pk, b),  C = H3(a, TOKEN, P)
// Nullifier (5.5):  sigma = H3(sk, C, i),  N = H3(C, i, sigma)
// Merkle (5.6):     node = H2(left, right), index bits = Num2Bits(levels)(i), LSB = leaf level
//
// Public signals (declaration order = snarkjs order):
//   root, publicAmount, extDataHash, inputNullifier[nIns], outputCommitment[nOuts]
template Transaction(levels, nIns, nOuts, TOKEN) {
    signal input root;
    // p - v (v = total value leaving the pool), or 0. Computed by HubCore from ExtData,
    // which also enforces v < 2^248 (PRD 5.7, 5.11).
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    signal input inAmount[nIns];
    signal input inSk[nIns];
    signal input inBlinding[nIns];
    signal input inLeafIndex[nIns];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPk[nOuts];
    signal input outBlinding[nOuts];

    component inKey[nIns];        // pk_j = H1(sk_j)
    component inOwner[nIns];      // P_j = H2(pk_j, b_j)
    component inCommit[nIns];     // C_j = H3(a_j, TOKEN, P_j)
    component inSig[nIns];        // sigma_j = H3(sk_j, C_j, i_j)
    component inNullifier[nIns];  // N_j = H3(C_j, i_j, sigma_j)
    component inAmountBits[nIns]; // a_j < 2^248
    component inIndexBits[nIns];  // i_j < 2^levels, and the Merkle path bits
    component inTree[nIns];
    component inRootCheck[nIns];

    var sumIns = 0;
    for (var j = 0; j < nIns; j++) {
        inKey[j] = Poseidon(1);
        inKey[j].inputs[0] <== inSk[j];

        inOwner[j] = Poseidon(2);
        inOwner[j].inputs[0] <== inKey[j].out;
        inOwner[j].inputs[1] <== inBlinding[j];

        inCommit[j] = Poseidon(3);
        inCommit[j].inputs[0] <== inAmount[j];
        inCommit[j].inputs[1] <== TOKEN;
        inCommit[j].inputs[2] <== inOwner[j].out;

        inSig[j] = Poseidon(3);
        inSig[j].inputs[0] <== inSk[j];
        inSig[j].inputs[1] <== inCommit[j].out;
        inSig[j].inputs[2] <== inLeafIndex[j];

        inNullifier[j] = Poseidon(3);
        inNullifier[j].inputs[0] <== inCommit[j].out;
        inNullifier[j].inputs[1] <== inLeafIndex[j];
        inNullifier[j].inputs[2] <== inSig[j].out;
        inNullifier[j].out === inputNullifier[j];

        inAmountBits[j] = Num2Bits(248);
        inAmountBits[j].in <== inAmount[j];

        inIndexBits[j] = Num2Bits(levels);
        inIndexBits[j].in <== inLeafIndex[j];

        inTree[j] = MerkleProof(levels);
        inTree[j].leaf <== inCommit[j].out;
        for (var l = 0; l < levels; l++) {
            inTree[j].pathElements[l] <== inPathElements[j][l];
            inTree[j].pathIndices[l] <== inIndexBits[j].out[l];
        }

        // Membership is enforced for every input with a non-zero amount (dummy inputs,
        // a_j = 0, skip it; PRD 5.11).
        inRootCheck[j] = ForceEqualIfEnabled();
        inRootCheck[j].in[0] <== root;
        inRootCheck[j].in[1] <== inTree[j].root;
        inRootCheck[j].enabled <== inAmount[j];

        sumIns += inAmount[j];
    }

    component outOwner[nOuts];
    component outCommit[nOuts];
    component outAmountBits[nOuts];

    var sumOuts = 0;
    for (var k = 0; k < nOuts; k++) {
        outOwner[k] = Poseidon(2);
        outOwner[k].inputs[0] <== outPk[k];
        outOwner[k].inputs[1] <== outBlinding[k];

        outCommit[k] = Poseidon(3);
        outCommit[k].inputs[0] <== outAmount[k];
        outCommit[k].inputs[1] <== TOKEN;
        outCommit[k].inputs[2] <== outOwner[k].out;
        outCommit[k].out === outputCommitment[k];

        outAmountBits[k] = Num2Bits(248);
        outAmountBits[k].in <== outAmount[k];

        sumOuts += outAmount[k];
    }

    // No two inputs of one spend may share a nullifier.
    component sameNullifier[nIns * (nIns - 1) \ 2];
    var idx = 0;
    for (var a = 0; a < nIns - 1; a++) {
        for (var b = a + 1; b < nIns; b++) {
            sameNullifier[idx] = IsEqual();
            sameNullifier[idx].in[0] <== inputNullifier[a];
            sameNullifier[idx].in[1] <== inputNullifier[b];
            sameNullifier[idx].out === 0;
            idx++;
        }
    }

    // Balance: a_0 + a_1 + publicAmount = a'_0 + a'_1 (mod p); with the range checks and
    // v < 2^248 this holds over the integers (PRD 5.11).
    sumIns + publicAmount === sumOuts;

    // Keeps extDataHash bound as a constrained public input.
    signal extDataSquare <== extDataHash * extDataHash;
}
