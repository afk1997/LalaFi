// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LockReleaseMessenger} from "../../src/testnet/LockReleaseMessenger.sol";
import {TestDai} from "./TwoChainPool.t.sol";

contract LockReleaseMessengerTest is Test {
    TestDai dai;
    LockReleaseMessenger src; // domain 0 (Sepolia)
    LockReleaseMessenger dst; // domain 6 (Base)
    uint256 attesterKey = 0xA77E57;
    address lm = makeAddr("lm");
    address spoke = makeAddr("spoke");

    function setUp() public {
        dai = new TestDai();
        src = new LockReleaseMessenger(address(dai), 0, vm.addr(attesterKey));
        dst = new LockReleaseMessenger(address(dai), 6, vm.addr(attesterKey));
        dai.mint(lm, 100e18);
        dai.mint(address(dst), 1000e18); // destination stock
    }

    function _burn(uint256 amount) internal returns (bytes memory message) {
        vm.startPrank(lm);
        dai.approve(address(src), amount);
        vm.recordLogs();
        src.depositForBurn(amount, 6, bytes32(uint256(uint160(spoke))), address(dai), 0, 0, 2000);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        message = abi.decode(logs[logs.length - 1].data, (bytes));
    }

    function _sign(bytes memory m, uint256 k) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, keccak256(m));
        return abi.encodePacked(r, s, v);
    }

    function test_lockThenRelease() public {
        bytes memory m = _burn(40e18);
        assertEq(dai.balanceOf(address(src)), 40e18);
        dst.receiveMessage(m, _sign(m, attesterKey));
        assertEq(dai.balanceOf(spoke), 40e18);
        assertEq(dai.balanceOf(address(dst)), 960e18);
    }

    function test_rejectsReplayWrongSignerWrongDomain() public {
        bytes memory m = _burn(1e18);
        vm.expectRevert(LockReleaseMessenger.BadAttestation.selector);
        dst.receiveMessage(m, _sign(m, 0xBAD));
        vm.expectRevert(abi.encodeWithSelector(LockReleaseMessenger.WrongDomain.selector, uint32(6)));
        src.receiveMessage(m, _sign(m, attesterKey));
        dst.receiveMessage(m, _sign(m, attesterKey));
        vm.expectRevert(abi.encodeWithSelector(LockReleaseMessenger.NonceUsed.selector, uint32(0), uint64(0)));
        dst.receiveMessage(m, _sign(m, attesterKey));
    }

    function test_rejectsOtherTokens() public {
        vm.prank(lm);
        vm.expectRevert(abi.encodeWithSelector(LockReleaseMessenger.WrongToken.selector, address(1)));
        src.depositForBurn(1e18, 6, bytes32(0), address(1), 0, 0, 2000);
    }
}

import {Vm} from "forge-std/Vm.sol";
