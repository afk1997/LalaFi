pragma circom 2.1.9;

include "./transaction.circom";

// Public signals: [root, publicAmount, extDataHash, inputNullifier[0], inputNullifier[1],
//                  outputCommitment[0], outputCommitment[1]]
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(24, 2, 2, 1);
