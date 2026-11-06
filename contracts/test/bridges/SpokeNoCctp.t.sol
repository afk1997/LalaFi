// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeBase} from "./BridgeBase.t.sol";
import {OpStackSpoke} from "../../src/spoke/OpStackSpoke.sol";
import {ArbitrumSpoke} from "../../src/spoke/ArbitrumSpoke.sol";
import {Spoke} from "../../src/spoke/Spoke.sol";
import {ISpoke} from "../../src/interfaces/ISpoke.sol";
import {MSG_REBALANCE} from "../../src/libraries/Types.sol";

/// @notice A spoke deployed without CCTP (tokenMessengerV2 == 0, e.g. the DAI pool): deposits and
///         releases work as usual, rebalance orders are ignored (no revert, nothing reserved or moved).
contract SpokeNoCctpTest is BridgeBase {
    function setUp() public override {
        super.setUp();
        opSpoke = new OpStackSpoke(_cfg(opAdapter, address(0)), address(l2m));
        arbSpoke = new ArbitrumSpoke(_cfg(arbAdapter, address(0)));
        vm.startPrank(user);
        usdc.approve(address(opSpoke), type(uint256).max);
        usdc.approve(address(arbSpoke), type(uint256).max);
        vm.stopPrank();
    }

    function test_constructor_acceptsZeroTokenMessenger() public view {
        assertEq(opSpoke.tokenMessengerV2(), address(0));
        assertEq(arbSpoke.tokenMessengerV2(), address(0));
    }

    function test_rebalance_ignored_op() public {
        _deposit(opSpoke, 100e6);
        uint256 bal = usdc.balanceOf(address(opSpoke));
        vm.expectEmit(address(opSpoke));
        emit ISpoke.HubMessageIgnored(MSG_REBALANCE, abi.encodeWithSelector(Spoke.RebalanceDisabled.selector, 7));
        _deliverOp(_rebalance(7, 50e6));
        assertEq(usdc.balanceOf(address(opSpoke)), bal, "funds moved");
        assertEq(opSpoke.queuedAmount(), 0);
        assertEq(opSpoke.failedAmount(), 0);
        assertEq(opSpoke.queueTail(), 0);
        assertEq(uint8(opSpoke.rebalanceState(7)), 0, "recorded");

        // more than the balance: still ignored, nothing queued
        _deliverOp(_rebalance(8, 1e12));
        assertEq(opSpoke.queuedAmount(), 0);
        assertEq(opSpoke.queueTail(), 0);
        assertEq(usdc.balanceOf(address(opSpoke)), bal);
    }

    function test_rebalance_ignored_arb() public {
        _deposit(arbSpoke, 100e6);
        uint256 bal = usdc.balanceOf(address(arbSpoke));
        vm.expectEmit(address(arbSpoke));
        emit ISpoke.HubMessageIgnored(MSG_REBALANCE, abi.encodeWithSelector(Spoke.RebalanceDisabled.selector, 1));
        _deliverArb(_rebalance(1, 50e6));
        assertEq(usdc.balanceOf(address(arbSpoke)), bal);
        assertEq(arbSpoke.queuedAmount() + arbSpoke.failedAmount(), 0);
    }

    function test_releases_stillWork() public {
        _deposit(opSpoke, 100e6);
        address to = makeAddr("to");
        _deliverOp(_release(0, to, 40e6));
        assertEq(usdc.balanceOf(to), 40e6);
    }
}
