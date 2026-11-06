// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMockBridge} from "../interfaces/IMocks.sol";

/// @notice LOCAL ONLY. Arbitrum-style Bridge on the L1. Created by MockOutbox, whose address becomes the
///         (fixed) active outbox, so there is no setter.
contract MockBridge is IMockBridge {
    error NotOutbox();

    address public immutable override activeOutbox;

    constructor() {
        activeOutbox = msg.sender;
    }

    function executeCall(address to, uint256 value, bytes calldata data)
        external
        override
        returns (bool success, bytes memory returnData)
    {
        if (msg.sender != activeOutbox) revert NotOutbox();
        (success, returnData) = to.call{value: value}(data);
    }

    receive() external payable {}
}
