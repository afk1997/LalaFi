// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMockOutbox} from "../interfaces/IMocks.sol";
import {MockBridge} from "./MockBridge.sol";

/// @notice LOCAL ONLY. Arbitrum-style Outbox on the L1. Deploys its own MockBridge (exposed as `bridge`).
///         Only `relayer` (the mock-bridge service) executes L2->L1 messages, standing in for the
///         assertion-confirmation + merkle proof of the real outbox.
contract MockOutbox is IMockOutbox {
    error NotRelayer();
    error AlreadySpent(uint256 position);
    error CallFailed(bytes returnData);

    address public immutable override relayer;
    MockBridge public immutable bridge;
    mapping(uint256 => bool) public isSpent;
    address internal _l2ToL1Sender;

    constructor(address relayer_) {
        relayer = relayer_;
        bridge = new MockBridge();
    }

    /// @dev address(0) outside an execution (same as the real outbox).
    function l2ToL1Sender() external view override returns (address) {
        return _l2ToL1Sender;
    }

    function executeTransaction(uint256 position, address l2Sender, address to, bytes calldata data)
        external
        override
    {
        if (msg.sender != relayer) revert NotRelayer();
        if (isSpent[position]) revert AlreadySpent(position);
        isSpent[position] = true;

        address prev = _l2ToL1Sender;
        _l2ToL1Sender = l2Sender;
        (bool ok, bytes memory ret) = bridge.executeCall(to, 0, data);
        _l2ToL1Sender = prev;
        if (!ok) revert CallFailed(ret);

        emit OutBoxTransactionExecuted(to, l2Sender, position);
    }
}
