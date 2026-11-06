// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal OP Stack CrossDomainMessenger surface (L1 and L2 share it).
///         L2 predeploy: 0x4200000000000000000000000000000000000007
interface ICrossDomainMessenger {
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external payable;
    function xDomainMessageSender() external view returns (address);
}
