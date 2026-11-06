// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal Arbitrum Nitro surfaces used by xpool.

interface IInbox {
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);

    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) external view returns (uint256);
}

interface IBridge {
    function activeOutbox() external view returns (address);
}

interface IOutbox {
    function l2ToL1Sender() external view returns (address);
}

/// @dev Precompile at address(100) on Arbitrum.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
    function sendTxToL1(address destination, bytes calldata data) external payable returns (uint256);
}

address constant ARB_SYS = address(100);

library AddressAliasHelper {
    uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);

    function applyL1ToL2Alias(address l1Address) internal pure returns (address l2Address) {
        unchecked {
            l2Address = address(uint160(l1Address) + OFFSET);
        }
    }

    function undoL1ToL2Alias(address l2Address) internal pure returns (address l1Address) {
        unchecked {
            l1Address = address(uint160(l2Address) - OFFSET);
        }
    }
}
