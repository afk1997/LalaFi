// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IHubAdapter} from "../../interfaces/IHubAdapter.sol";
import {ISpoke} from "../../interfaces/ISpoke.sol";
import {IDepositManager} from "../../interfaces/IDepositManager.sol";
import {IInbox, IBridge, IOutbox} from "../../interfaces/external/IArbitrum.sol";
import {ArbitrumHubAdapterConfig} from "../../libraries/DeployConfig.sol";
import {BridgeParams} from "../../libraries/Types.sol";
import {AdapterLib} from "./AdapterLib.sol";

/// @title ArbitrumHubAdapter: hub side of the Arbitrum spoke (PRD 7.8, Arbitrum column).
/// @notice Down: Inbox.createRetryableTicket{value}(spoke, 0, ...). The L2 sender is alias(this).
///         Up:   only the Bridge, executing an outbox message whose l2ToL1Sender is the spoke.
/// @dev DEVIATION (security): callValueRefundAddress (the retryable's beneficiary, who can CANCEL
///      the ticket) is the spoke, not the relayer-chosen refund address. The spoke has no code path
///      that cancels, so nobody can cancel a release / rebalance / pause ticket; l2CallValue is 0,
///      so nothing is ever refunded there. Excess fees go to bp.refundAddress.
contract ArbitrumHubAdapter is IHubAdapter, ReentrancyGuardTransient {
    error GasLimitTooLow();
    error ZeroRefundAddress();

    address public immutable inbox;
    address public immutable bridge;
    address public immutable override spoke;
    uint64 public immutable override spokeChainId;
    address public immutable override hub;
    address public immutable override liquidityManager;
    address public immutable override depositManager;
    uint256 public immutable minGasL2;

    constructor(ArbitrumHubAdapterConfig memory cfg) {
        AdapterLib.requireNonZero(cfg.inbox);
        AdapterLib.requireNonZero(cfg.bridge);
        AdapterLib.requireNonZero(cfg.spoke);
        AdapterLib.requireNonZero(cfg.hub);
        AdapterLib.requireNonZero(cfg.liquidityManager);
        AdapterLib.requireNonZero(cfg.depositManager);
        if (cfg.spokeChainId == 0 || cfg.minGasL2 == 0) revert AdapterLib.BadConfig();
        inbox = cfg.inbox;
        bridge = cfg.bridge;
        spoke = cfg.spoke;
        spokeChainId = cfg.spokeChainId;
        hub = cfg.hub;
        liquidityManager = cfg.liquidityManager;
        depositManager = cfg.depositManager;
        minGasL2 = cfg.minGasL2;
    }

    /// @inheritdoc IHubAdapter
    function sendToSpoke(bytes calldata message, BridgeParams calldata bp) external payable override nonReentrant {
        uint8 kind = AdapterLib.checkDownMessage(message, hub, liquidityManager);
        if (bp.gasLimit < minGasL2) revert GasLimitTooLow();
        if (bp.refundAddress == address(0)) revert ZeroRefundAddress();
        if (msg.value < bp.maxSubmissionCost + bp.gasLimit * bp.maxFeePerGas) revert InsufficientValue();
        emit SentToSpoke(kind, keccak256(message));
        IInbox(inbox).createRetryableTicket{value: msg.value}(
            spoke,
            0,
            bp.maxSubmissionCost,
            bp.refundAddress,
            spoke,
            bp.gasLimit,
            bp.maxFeePerGas,
            abi.encodeCall(ISpoke.receiveFromHub, (message))
        );
    }

    /// @inheritdoc IHubAdapter
    function receiveFromSpoke(bytes calldata message) external override nonReentrant {
        if (msg.sender != bridge || IOutbox(IBridge(bridge).activeOutbox()).l2ToL1Sender() != spoke) {
            revert NotFromSpoke();
        }
        bytes memory body = AdapterLib.checkpointBody(message);
        emit ReceivedFromSpoke(keccak256(message));
        IDepositManager(depositManager).receiveCheckpoint(spokeChainId, body);
    }
}
