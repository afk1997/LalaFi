// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {P} from "./Types.sol";

/// @title BN254 scalar-field helpers (PRD 5.1).
library Field {
    /// @dev Same selector as IHubCore.FieldOverflow / IDepositManager.FieldOverflow.
    error FieldOverflow();

    /// @notice True iff x is a canonical field element (x < p).
    function isField(uint256 x) internal pure returns (bool) {
        return x < P;
    }

    /// @notice Reverts FieldOverflow() unless x < p.
    function requireField(uint256 x) internal pure {
        if (x >= P) revert FieldOverflow();
    }

    /// @notice keccak-derived field element: uint256(h) mod p (PRD 5.1; extDataHash and Z0 only).
    function fromHash(bytes32 h) internal pure returns (uint256) {
        return uint256(h) % P;
    }

    /// @notice Field negation of an integer v < p: 0 -> 0, v -> p - v (publicAmount encoding, PRD 5.7).
    function neg(uint256 v) internal pure returns (uint256) {
        if (v >= P) revert FieldOverflow();
        return v == 0 ? 0 : P - v;
    }
}
