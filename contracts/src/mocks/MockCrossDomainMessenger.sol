// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMockCrossDomainMessenger} from "../interfaces/IMocks.sol";

/// @notice LOCAL ONLY. OP-style CrossDomainMessenger, deployed on the L1 (31337) and on the OP-style
///         L2 (31338). services/mock-bridge watches `SentMessage` on one side and calls `relayMessage`
///         on the other. Mirrors the real authentication semantics: xDomainMessageSender() is only
///         set during a relay and reverts otherwise.
contract MockCrossDomainMessenger is IMockCrossDomainMessenger {
    error NotRelayer();
    error AlreadyRelayed();
    error NotInRelay();
    error ReentrantRelay();

    address internal constant DEFAULT_SENDER = 0x000000000000000000000000000000000000dEaD;

    address public immutable override relayer;
    uint256 public messageNonce;
    address internal _xDomainSender = DEFAULT_SENDER;
    mapping(bytes32 => bool) public successfulMessages;
    mapping(bytes32 => bool) public failedMessages;

    constructor(address relayer_) {
        relayer = relayer_;
    }

    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external payable override {
        emit SentMessage(target, msg.sender, message, messageNonce++, minGasLimit);
    }

    function xDomainMessageSender() external view override returns (address) {
        if (_xDomainSender == DEFAULT_SENDER) revert NotInRelay();
        return _xDomainSender;
    }

    function relayMessage(uint256 nonce, address sender, address target, bytes calldata message, uint256 gasLimit)
        external
        override
    {
        if (msg.sender != relayer) revert NotRelayer();
        if (_xDomainSender != DEFAULT_SENDER) revert ReentrantRelay();
        bytes32 h = hashMessage(nonce, sender, target, message);
        if (successfulMessages[h]) revert AlreadyRelayed();

        _xDomainSender = sender;
        (bool ok,) = target.call{gas: gasLimit}(message);
        _xDomainSender = DEFAULT_SENDER;

        if (ok) {
            successfulMessages[h] = true;
            failedMessages[h] = false;
            emit RelayedMessage(h);
        } else {
            failedMessages[h] = true;
            emit FailedRelayedMessage(h);
        }
    }

    function hashMessage(uint256 nonce, address sender, address target, bytes calldata message)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(nonce, sender, target, message));
    }
}
