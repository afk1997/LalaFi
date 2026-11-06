// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMockInbox} from "../interfaces/IMocks.sol";

/// @notice LOCAL ONLY. Arbitrum-style Inbox on the L1 (31337). Emits RetryableCreated; services/mock-bridge
///         delivers on 31339 by impersonating AddressAliasHelper.applyL1ToL2Alias(from) and calling `to`.
contract MockInbox is IMockInbox {
    error InsufficientValue(uint256 expected, uint256 actual);
    error InsufficientSubmissionCost(uint256 expected, uint256 actual);

    uint256 public ticketCount;

    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address, /* excessFeeRefundAddress */
        address, /* callValueRefundAddress */
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable override returns (uint256 ticketId) {
        uint256 expected = maxSubmissionCost + l2CallValue + gasLimit * maxFeePerGas;
        if (msg.value < expected) revert InsufficientValue(expected, msg.value);
        uint256 fee = calculateRetryableSubmissionFee(data.length, 0);
        if (maxSubmissionCost < fee) revert InsufficientSubmissionCost(fee, maxSubmissionCost);
        ticketId = ticketCount++;
        emit RetryableCreated(ticketId, msg.sender, to, l2CallValue, gasLimit, data);
    }

    /// @dev Same formula as Nitro: (1400 + 6 * dataLength) * baseFee (block.basefee when baseFee == 0).
    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee)
        public
        view
        override
        returns (uint256)
    {
        return (1400 + 6 * dataLength) * (baseFee == 0 ? block.basefee : baseFee);
    }
}
