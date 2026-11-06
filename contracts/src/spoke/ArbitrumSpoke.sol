// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Spoke} from "./Spoke.sol";
import {SpokeConfig} from "../libraries/DeployConfig.sol";
import {IHubAdapter} from "../interfaces/IHubAdapter.sol";
import {IArbSys, ARB_SYS, AddressAliasHelper} from "../interfaces/external/IArbitrum.sol";

/// @title ArbitrumSpoke: the Arbitrum spoke (PRD 7.8, Arbitrum column).
contract ArbitrumSpoke is Spoke {
    /// @dev L2 alias of the hub adapter: the only address that can deliver retryables from it.
    address public immutable aliasedHubAdapter;

    constructor(SpokeConfig memory cfg) Spoke(cfg) {
        aliasedHubAdapter = AddressAliasHelper.applyL1ToL2Alias(cfg.hubAdapter);
    }

    function _isFromHub() internal view override returns (bool) {
        return msg.sender == aliasedHubAdapter;
    }

    function _sendToHub(bytes memory message) internal override {
        IArbSys(ARB_SYS).sendTxToL1(hubAdapter, abi.encodeCall(IHubAdapter.receiveFromSpoke, (message)));
    }

    /// @dev block.number on Arbitrum is an approximate L1 block number; the L2 clock is ArbSys.
    function _l2BlockNumber() internal view override returns (uint64) {
        return uint64(IArbSys(ARB_SYS).arbBlockNumber());
    }
}
