// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Signature of the snarkjs-generated Groth16 verifier (7 public signals).
interface IVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[7] calldata _pubSignals
    ) external view returns (bool);
}
