// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVerifier} from "../interfaces/IVerifier.sol";

/// @notice TEST ONLY. Accepts every proof unless toggled off. Never deployed outside unit tests.
contract MockVerifier is IVerifier {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[7] calldata)
        external
        view
        returns (bool)
    {
        return result;
    }
}
