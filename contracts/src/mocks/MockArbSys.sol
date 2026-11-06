// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMockArbSys} from "../interfaces/IMocks.sol";

/// @notice LOCAL ONLY. Placed at address(100) on 31339 with anvil_setCode (runtime code only, so this
///         contract has no constructor and no immutables). services/mock-bridge watches L2ToL1Tx and
///         executes it on the L1 through MockOutbox.
contract MockArbSys is IMockArbSys {
    uint256 public nextPosition;

    function arbBlockNumber() external view override returns (uint256) {
        return block.number;
    }

    function sendTxToL1(address destination, bytes calldata data) external payable override returns (uint256 position) {
        position = nextPosition++;
        emit L2ToL1Tx(msg.sender, destination, position, data);
    }
}
