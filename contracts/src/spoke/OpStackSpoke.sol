// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Spoke} from "./Spoke.sol";
import {SpokeConfig} from "../libraries/DeployConfig.sol";
import {IHubAdapter} from "../interfaces/IHubAdapter.sol";
import {ICrossDomainMessenger} from "../interfaces/external/IOpStack.sol";

/// @title OpStackSpoke: the Base spoke (PRD 7.8, OP Stack column).
/// @dev l2Messenger is the L2CrossDomainMessenger predeploy 0x4200...0007 on Base / Base Sepolia,
///      and MockCrossDomainMessenger locally.
contract OpStackSpoke is Spoke {
    address public immutable l2Messenger;

    constructor(SpokeConfig memory cfg, address l2Messenger_) Spoke(cfg) {
        if (l2Messenger_ == address(0)) revert ZeroAddress();
        l2Messenger = l2Messenger_;
    }

    /// @dev msg.sender == L2 messenger && xDomainMessageSender() == hubAdapter. The messenger is only
    ///      queried after the sender check (the real one reverts outside a relay).
    function _isFromHub() internal view override returns (bool) {
        return msg.sender == l2Messenger && ICrossDomainMessenger(l2Messenger).xDomainMessageSender() == hubAdapter;
    }

    function _sendToHub(bytes memory message) internal override {
        ICrossDomainMessenger(l2Messenger).sendMessage(
            hubAdapter, abi.encodeCall(IHubAdapter.receiveFromSpoke, (message)), minGasL1
        );
    }

    function _l2BlockNumber() internal view override returns (uint64) {
        return uint64(block.number);
    }
}
