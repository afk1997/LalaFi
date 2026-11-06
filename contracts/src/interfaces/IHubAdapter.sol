// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeParams} from "../libraries/Types.sol";

/// @title Hub-side bridge adapter (one per spoke). OpStackHubAdapter (Base), ArbitrumHubAdapter (Arbitrum).
/// @notice Down: wraps messages in ISpoke.receiveFromHub(message) and sends through the official bridge.
///         Up:   the official bridge calls receiveFromSpoke(message); the adapter authenticates
///               (OP: msg.sender == L1CrossDomainMessenger && xDomainMessageSender() == spoke;
///                Arbitrum: msg.sender == bridge && IOutbox(bridge.activeOutbox()).l2ToL1Sender() == spoke),
///               requires kind == MSG_CHECKPOINT, and forwards body to
///               DepositManager.receiveCheckpoint(spokeChainId, body).
interface IHubAdapter {
    error Unauthorized();
    error NotFromSpoke();
    error BadMessageKind();
    error InsufficientValue();

    event SentToSpoke(uint8 indexed kind, bytes32 messageHash);
    event ReceivedFromSpoke(bytes32 messageHash);

    /// @notice Only HubCore or LiquidityManager. message = abi.encode(uint8 kind, bytes body).
    ///         OP: msg.value must be 0. Arbitrum: msg.value >= maxSubmissionCost + gasLimit * maxFeePerGas.
    function sendToSpoke(bytes calldata message, BridgeParams calldata bp) external payable;

    /// @notice Only the official bridge with the spoke as authenticated L2 sender.
    function receiveFromSpoke(bytes calldata message) external;

    function spoke() external view returns (address);
    function spokeChainId() external view returns (uint64);
    function hub() external view returns (address);
    function liquidityManager() external view returns (address);
    function depositManager() external view returns (address);
}
