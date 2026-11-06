// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IHubAdapter} from "../../interfaces/IHubAdapter.sol";
import {ISpoke} from "../../interfaces/ISpoke.sol";
import {IDepositManager} from "../../interfaces/IDepositManager.sol";
import {ICrossDomainMessenger} from "../../interfaces/external/IOpStack.sol";
import {OpStackHubAdapterConfig} from "../../libraries/DeployConfig.sol";
import {BridgeParams} from "../../libraries/Types.sol";
import {AdapterLib} from "./AdapterLib.sol";

/// @title OpStackHubAdapter: hub side of the Base spoke (PRD 7.8, OP Stack column).
/// @notice Down: L1CrossDomainMessenger.sendMessage(spoke, receiveFromHub(m), minGasL2).
///         Up:   only L1CrossDomainMessenger relaying a message whose xDomainMessageSender is the spoke.
///         No owner, no admin, no state.
contract OpStackHubAdapter is IHubAdapter, ReentrancyGuardTransient {
    error UnexpectedValue();

    address public immutable l1Messenger;
    address public immutable override spoke;
    uint64 public immutable override spokeChainId;
    address public immutable override hub;
    address public immutable override liquidityManager;
    address public immutable override depositManager;
    uint32 public immutable minGasL2;

    constructor(OpStackHubAdapterConfig memory cfg) {
        AdapterLib.requireNonZero(cfg.l1Messenger);
        AdapterLib.requireNonZero(cfg.spoke);
        AdapterLib.requireNonZero(cfg.hub);
        AdapterLib.requireNonZero(cfg.liquidityManager);
        AdapterLib.requireNonZero(cfg.depositManager);
        if (cfg.spokeChainId == 0 || cfg.minGasL2 == 0) revert AdapterLib.BadConfig();
        l1Messenger = cfg.l1Messenger;
        spoke = cfg.spoke;
        spokeChainId = cfg.spokeChainId;
        hub = cfg.hub;
        liquidityManager = cfg.liquidityManager;
        depositManager = cfg.depositManager;
        minGasL2 = cfg.minGasL2;
    }

    /// @inheritdoc IHubAdapter
    function sendToSpoke(bytes calldata message, BridgeParams calldata) external payable override nonReentrant {
        uint8 kind = AdapterLib.checkDownMessage(message, hub, liquidityManager);
        if (msg.value != 0) revert UnexpectedValue();
        emit SentToSpoke(kind, keccak256(message));
        ICrossDomainMessenger(l1Messenger).sendMessage(spoke, abi.encodeCall(ISpoke.receiveFromHub, (message)), minGasL2);
    }

    /// @inheritdoc IHubAdapter
    function receiveFromSpoke(bytes calldata message) external override nonReentrant {
        if (msg.sender != l1Messenger || ICrossDomainMessenger(l1Messenger).xDomainMessageSender() != spoke) {
            revert NotFromSpoke();
        }
        bytes memory body = AdapterLib.checkpointBody(message);
        emit ReceivedFromSpoke(keccak256(message));
        IDepositManager(depositManager).receiveCheckpoint(spokeChainId, body);
    }
}
