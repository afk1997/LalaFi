// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHubAdapter} from "../../interfaces/IHubAdapter.sol";
import {MSG_RELEASE, MSG_REBALANCE, MSG_PAUSE, MSG_CHECKPOINT} from "../../libraries/Types.sol";

/// @dev Shared checks of the two hub adapters (internal functions only: inlined, no linking).
library AdapterLib {
    error ZeroAddress();
    error BadConfig();

    function requireNonZero(address a) internal pure {
        if (a == address(0)) revert ZeroAddress();
    }

    /// @dev Caller/kind matrix: HubCore may send RELEASE and PAUSE, LiquidityManager only REBALANCE.
    function checkDownMessage(bytes calldata message, address hub, address liquidityManager)
        internal
        view
        returns (uint8 kind)
    {
        if (msg.sender != hub && msg.sender != liquidityManager) revert IHubAdapter.Unauthorized();
        (kind,) = abi.decode(message, (uint8, bytes));
        if (msg.sender == hub) {
            if (kind != MSG_RELEASE && kind != MSG_PAUSE) revert IHubAdapter.BadMessageKind();
        } else if (kind != MSG_REBALANCE) {
            revert IHubAdapter.BadMessageKind();
        }
    }

    function checkpointBody(bytes calldata message) internal pure returns (bytes memory body) {
        uint8 kind;
        (kind, body) = abi.decode(message, (uint8, bytes));
        if (kind != MSG_CHECKPOINT) revert IHubAdapter.BadMessageKind();
    }
}
