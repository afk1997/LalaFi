// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMockTokenMessengerV2} from "../interfaces/IMocks.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice LOCAL ONLY. CCTP V2 TokenMessenger stand-in. Pulls and burns `amount` (needs the MockUSDC minter
///         role for burn) and emits MessageSent(abi.encode(nonce, srcDomain, dstDomain, mintRecipient, amount, maxFee)).
contract MockTokenMessengerV2 is IMockTokenMessengerV2 {
    using SafeERC20 for IERC20;

    error UnsupportedToken();
    error BadAmount();
    error BadRecipient();

    address public immutable usdc;
    uint32 public immutable override localDomain;
    uint64 public nextNonce;

    constructor(address usdc_, uint32 localDomain_) {
        usdc = usdc_;
        localDomain = localDomain_;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32, /* destinationCaller */
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external override {
        if (burnToken != usdc) revert UnsupportedToken();
        if (amount == 0 || maxFee >= amount) revert BadAmount();
        if (mintRecipient == bytes32(0)) revert BadRecipient();
        uint64 nonce = nextNonce++;

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        MockUSDC(usdc).burn(address(this), amount);

        emit DepositForBurn(
            nonce, burnToken, amount, msg.sender, mintRecipient, destinationDomain, maxFee, minFinalityThreshold
        );
        emit MessageSent(abi.encode(nonce, localDomain, destinationDomain, mintRecipient, amount, maxFee));
    }
}
