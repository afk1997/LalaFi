// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// @notice Circle CCTP V2 surfaces used by xpool (developers.circle.com/cctp).
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

// @dev CCTP V2 finality thresholds.
uint32 constant CCTP_FINALITY_FAST = 1000;
uint32 constant CCTP_FINALITY_STANDARD = 2000;

// @dev CCTP domains (same ids on testnets).
uint32 constant CCTP_DOMAIN_ETHEREUM = 0;
uint32 constant CCTP_DOMAIN_ARBITRUM = 3;
uint32 constant CCTP_DOMAIN_BASE = 6;
