// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice poseidon-solidity libraries, deployed once and called via STATICCALL
///         (library `public pure` functions are callable externally).
///         Addresses are constructor immutables of every contract that hashes.
interface IPoseidonT3 {
    /// @dev H2 (circomlib Poseidon(2))
    function hash(uint256[2] memory) external pure returns (uint256);
}

interface IPoseidonT4 {
    /// @dev H3 (circomlib Poseidon(3))
    function hash(uint256[3] memory) external pure returns (uint256);
}
