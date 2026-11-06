// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {BridgeBase} from "./BridgeBase.t.sol";
import {RevertingTokenMessenger} from "./mocks/Doubles.sol";

import {OpStackSpoke} from "../../src/spoke/OpStackSpoke.sol";
import {ArbitrumSpoke} from "../../src/spoke/ArbitrumSpoke.sol";
import {Spoke} from "../../src/spoke/Spoke.sol";
import {ISpoke} from "../../src/interfaces/ISpoke.sol";
import {IHubAdapter} from "../../src/interfaces/IHubAdapter.sol";
import {IMockCrossDomainMessenger, IMockArbSys, IMockTokenMessengerV2} from "../../src/interfaces/IMocks.sol";
import {MockCrossDomainMessenger} from "../../src/mocks/MockCrossDomainMessenger.sol";
import {SpokeConfig} from "../../src/libraries/DeployConfig.sol";
import {AddressAliasHelper, ARB_SYS, IArbSys} from "../../src/interfaces/external/IArbitrum.sol";
import {
    P, MSG_RELEASE, MSG_CHECKPOINT, Release, Checkpoint, L2Deposit
} from "../../src/libraries/Types.sol";

contract SpokeTest is BridgeBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // =============================================================== deposit
    function test_deposit_storesAndPullsAmountPlusFee() public {
        uint256 before = usdc.balanceOf(user);
        vm.expectEmit(address(opSpoke));
        emit ISpoke.Deposit(0, 42, 5e6, FEE, uint64(block.number), hex"aabb");
        vm.prank(user);
        opSpoke.deposit(5e6, 42, hex"aabb");

        assertEq(usdc.balanceOf(user), before - 5e6 - FEE);
        assertEq(usdc.balanceOf(address(opSpoke)), 5e6 + FEE);
        ISpoke.StoredDeposit memory d = opSpoke.getDeposit(0);
        assertEq(d.ownerDigest, 42);
        assertEq(d.amount, 5e6);
        assertEq(d.fee, FEE);
        assertEq(d.l2Block, block.number);
        assertEq(opSpoke.depositCount(), 1);
    }

    function test_deposit_arbitrumUsesArbBlockNumber() public {
        vm.mockCall(ARB_SYS, abi.encodeCall(IArbSys.arbBlockNumber, ()), abi.encode(uint256(777_777)));
        _deposit(arbSpoke, 2e6);
        assertEq(arbSpoke.getDeposit(0).l2Block, 777_777);
        assertEq(arbSpoke.l2BlockNumber(), 777_777);
    }

    function test_deposit_reverts() public {
        vm.startPrank(user);
        vm.expectRevert(ISpoke.BadAmount.selector);
        opSpoke.deposit(MIN_DEP - 1, 1, "");
        vm.expectRevert(ISpoke.BadAmount.selector);
        opSpoke.deposit(MAX_DEP + 1, 1, "");
        vm.expectRevert(ISpoke.FieldOverflow.selector);
        opSpoke.deposit(MIN_DEP, P, "");
        vm.expectRevert(ISpoke.EncNoteTooLong.selector);
        opSpoke.deposit(MIN_DEP, 1, new bytes(257));
        opSpoke.deposit(MIN_DEP, P - 1, new bytes(256)); // boundaries ok
        vm.stopPrank();
    }

    function test_deposit_tvlCap() public {
        SpokeConfig memory c = _cfg(opAdapter, address(tm));
        c.tvlCap = MAX_DEP + FEE + MIN_DEP + FEE;
        OpStackSpoke s = new OpStackSpoke(c, address(l2m));
        vm.startPrank(user);
        usdc.approve(address(s), type(uint256).max);
        s.deposit(MAX_DEP, 1, "");
        vm.expectRevert(ISpoke.TvlCapExceeded.selector);
        s.deposit(MIN_DEP + 1, 1, "");
        s.deposit(MIN_DEP, 1, ""); // exactly at the cap
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(s)), c.tvlCap);
    }

    function test_constructor_badConfig() public {
        SpokeConfig memory c = _cfg(opAdapter, address(tm));
        c.minDeposit = 0;
        vm.expectRevert(Spoke.BadConfig.selector);
        new OpStackSpoke(c, address(l2m));
        c = _cfg(opAdapter, address(tm));
        c.maxCheckpoint = 0;
        vm.expectRevert(Spoke.BadConfig.selector);
        new OpStackSpoke(c, address(l2m));
        c = _cfg(address(0), address(tm));
        vm.expectRevert(Spoke.ZeroAddress.selector);
        new ArbitrumSpoke(c);
        c = _cfg(opAdapter, address(tm));
        vm.expectRevert(Spoke.ZeroAddress.selector);
        new OpStackSpoke(c, address(0));
    }

    // =============================================================== checkpoints
    function _lastOpCheckpoint() internal returns (Checkpoint memory cp, address target, uint256 gasLimit) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(l2m) && l.topics[0] == IMockCrossDomainMessenger.SentMessage.selector) {
                target = address(uint160(uint256(l.topics[1])));
                (address sender, bytes memory data,, uint256 gl) = abi.decode(l.data, (address, bytes, uint256, uint256));
                assertEq(sender, address(opSpoke));
                gasLimit = gl;
                cp = _decodeUp(data);
                return (cp, target, gasLimit);
            }
        }
        revert("no SentMessage");
    }

    function _decodeUp(bytes memory data) internal pure returns (Checkpoint memory) {
        assertEq(bytes4(data), IHubAdapter.receiveFromSpoke.selector);
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
        bytes memory envelope = abi.decode(args, (bytes));
        (uint8 kind, bytes memory body) = abi.decode(envelope, (uint8, bytes));
        assertEq(kind, MSG_CHECKPOINT);
        return abi.decode(body, (Checkpoint));
    }

    function test_checkpoint_chunksAndContents() public {
        for (uint256 i; i < 6; ++i) {
            _deposit(opSpoke, MIN_DEP + i);
            vm.roll(block.number + 1);
        }
        vm.recordLogs();
        vm.expectEmit(address(opSpoke));
        emit ISpoke.CheckpointSent(0, 0, MAX_CP, 6, uint64(block.number));
        opSpoke.sendCheckpoint();
        (Checkpoint memory cp, address target, uint256 gl) = _lastOpCheckpoint();
        assertEq(target, opAdapter);
        assertEq(gl, 200_000);
        assertEq(cp.seq, 0);
        assertEq(cp.from, 0);
        assertEq(cp.to, MAX_CP);
        assertEq(cp.countAtSend, 6);
        assertEq(cp.l2Block, block.number);
        assertEq(cp.deposits.length, MAX_CP);
        for (uint64 k; k < MAX_CP; ++k) {
            ISpoke.StoredDeposit memory d = opSpoke.getDeposit(k);
            assertEq(cp.deposits[k].index, k);
            assertEq(cp.deposits[k].ownerDigest, d.ownerDigest);
            assertEq(cp.deposits[k].amount, MIN_DEP + k);
            assertEq(cp.deposits[k].fee, FEE);
            assertEq(cp.deposits[k].l2Block, d.l2Block);
            assertLt(cp.deposits[k].l2Block, cp.l2Block);
        }

        vm.recordLogs();
        opSpoke.sendCheckpoint();
        (cp,,) = _lastOpCheckpoint();
        assertEq(cp.seq, 1);
        assertEq(cp.from, 4);
        assertEq(cp.to, 6);
        assertEq(cp.deposits.length, 2);
        assertEq(opSpoke.nextCheckpointFrom(), 6);
        assertEq(opSpoke.checkpointSeq(), 2);
    }

    function test_checkpoint_emptyRateLimit() public {
        opSpoke.sendCheckpoint(); // first empty is allowed
        vm.expectRevert(ISpoke.EmptyCheckpointTooSoon.selector);
        opSpoke.sendCheckpoint();
        vm.roll(block.number + EMPTY_INTERVAL - 1);
        vm.expectRevert(ISpoke.EmptyCheckpointTooSoon.selector);
        opSpoke.sendCheckpoint();
        // non-empty checkpoints are never rate limited
        _deposit(opSpoke, MIN_DEP);
        opSpoke.sendCheckpoint();
        _deposit(opSpoke, MIN_DEP);
        opSpoke.sendCheckpoint();
        vm.roll(block.number + 1);
        opSpoke.sendCheckpoint(); // empty, interval elapsed
        assertEq(opSpoke.checkpointSeq(), 4);
        assertEq(opSpoke.nextEmptyCheckpointBlock(), block.number + EMPTY_INTERVAL);
    }

    function test_checkpoint_arbitrumGoesThroughArbSys() public {
        _deposit(arbSpoke, MIN_DEP);
        vm.roll(block.number + 1);
        vm.recordLogs();
        arbSpoke.sendCheckpoint();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == ARB_SYS && logs[i].topics[0] == IMockArbSys.L2ToL1Tx.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), arbAdapter);
                (address caller, bytes memory data) = abi.decode(logs[i].data, (address, bytes));
                assertEq(caller, address(arbSpoke));
                Checkpoint memory cp = _decodeUp(data);
                assertEq(cp.deposits.length, 1);
                assertEq(cp.countAtSend, 1);
                found = true;
            }
        }
        assertTrue(found);
    }

    // =============================================================== releases
    function _fund(Spoke s, uint256 amount) internal {
        usdc.mint(address(s), amount);
    }

    function test_release_executes_andIsIdempotent() public {
        _fund(opSpoke, 100e6);
        vm.expectEmit(address(opSpoke));
        emit ISpoke.ReleaseExecuted(0, alice, 10e6);
        _deliverOp(_release(0, alice, 10e6));
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.Executed));

        // I7: a second delivery of the same index (resendRelease / replay) is ignored
        vm.expectEmit(address(opSpoke));
        emit ISpoke.HubMessageIgnored(MSG_RELEASE, abi.encodeWithSelector(Spoke.AlreadyHandled.selector, 0));
        _deliverOp(_release(0, alice, 10e6));
        // even with a different payload for the same index
        _deliverOp(_release(0, bob, 50e6));
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(usdc.balanceOf(address(opSpoke)), 90e6);
    }

    function test_release_arbitrum() public {
        _fund(arbSpoke, 100e6);
        _deliverArb(_release(3, alice, 7e6));
        assertEq(usdc.balanceOf(alice), 7e6);
        _deliverArb(_release(3, alice, 7e6));
        assertEq(usdc.balanceOf(alice), 7e6);
    }

    function test_release_wrongDestinationIgnored() public {
        _fund(opSpoke, 100e6);
        bytes memory m = abi.encode(
            MSG_RELEASE,
            abi.encode(Release({dstChainId: 999, index: 0, recipient: alice, amount: 1e6, spendId: bytes32(0)}))
        );
        vm.expectEmit(address(opSpoke));
        emit ISpoke.HubMessageIgnored(MSG_RELEASE, abi.encodeWithSelector(Spoke.WrongDestination.selector, 999));
        _deliverOp(m);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.None));
    }

    function test_release_queue_FIFO() public {
        _fund(opSpoke, 5e6);
        _deliverOp(_release(0, alice, 10e6)); // queued
        _deliverOp(_release(1, bob, 3e6)); // 5 < 10 + 3: queued behind
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.Queued));
        assertEq(uint8(opSpoke.releaseState(1)), uint8(ISpoke.ReleaseState.Queued));
        assertEq(opSpoke.queueLength(), 2);
        assertEq(opSpoke.queuedAmount(), 13e6);
        assertEq(opSpoke.freeBalance(), 0);

        opSpoke.processQueue(10); // head needs 10, only 5: strict FIFO, nothing paid
        assertEq(opSpoke.queueLength(), 2);
        assertEq(usdc.balanceOf(bob), 0);

        _fund(opSpoke, 6e6); // a CCTP mint lands: 11
        opSpoke.processQueue(10);
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(opSpoke.queueLength(), 1); // bob (3) waits: 1 left
        _fund(opSpoke, 2e6);
        opSpoke.processQueue(1);
        assertEq(usdc.balanceOf(bob), 3e6);
        assertEq(opSpoke.queueLength(), 0);
        assertEq(opSpoke.queuedAmount(), 0);
        assertEq(uint8(opSpoke.releaseState(1)), uint8(ISpoke.ReleaseState.Executed));
        // re-delivery of a queued-then-paid release is ignored
        _deliverOp(_release(1, bob, 3e6));
        assertEq(usdc.balanceOf(bob), 3e6);
    }

    function test_release_newReleaseCannotJumpQueuedReservation() public {
        _fund(opSpoke, 8e6);
        _deliverOp(_release(0, alice, 10e6)); // queued, reserves 10
        _deliverOp(_release(1, bob, 2e6)); // 8 < 10 + 2 -> queued
        assertEq(usdc.balanceOf(bob), 0);
        _fund(opSpoke, 10e6); // 18
        _deliverOp(_release(2, carol, 5e6)); // 18 >= 12 + 5 -> paid now
        assertEq(usdc.balanceOf(carol), 5e6);
        opSpoke.processQueue(type(uint256).max);
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(usdc.balanceOf(bob), 2e6);
    }

    function test_release_blacklistedRecipient_failed_thenRetry() public {
        _fund(opSpoke, 100e6);
        usdc.setBlacklisted(alice, true);
        vm.expectEmit(address(opSpoke));
        emit ISpoke.ReleaseFailed(0);
        _deliverOp(_release(0, alice, 10e6));
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.Failed));
        assertEq(opSpoke.failedAmount(), 10e6);
        assertEq(opSpoke.freeBalance(), 90e6);

        vm.expectRevert(Spoke.ReleaseTransferFailed.selector);
        opSpoke.retryFailedRelease(0);
        vm.expectRevert(ISpoke.NotFailed.selector);
        opSpoke.retryFailedRelease(1);

        // re-delivery does not double-book
        _deliverOp(_release(0, alice, 10e6));
        assertEq(opSpoke.failedAmount(), 10e6);

        usdc.setBlacklisted(alice, false);
        opSpoke.retryFailedRelease(0);
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(opSpoke.failedAmount(), 0);
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.Executed));
        vm.expectRevert(ISpoke.NotFailed.selector);
        opSpoke.retryFailedRelease(0);
    }

    function test_release_queuedThenBlacklisted_failsInQueue_retryRequeuesWithoutLiquidity() public {
        _fund(opSpoke, 1e6);
        _deliverOp(_release(0, alice, 10e6));
        usdc.setBlacklisted(alice, true);
        _fund(opSpoke, 20e6);
        opSpoke.processQueue(5);
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.Failed));
        assertEq(opSpoke.queuedAmount(), 0);
        assertEq(opSpoke.failedAmount(), 10e6);

        // liquidity leaves (another release), retry finds none -> back into the queue
        _deliverOp(_release(1, bob, 11e6));
        assertEq(usdc.balanceOf(bob), 11e6);
        usdc.setBlacklisted(alice, false);
        vm.prank(address(opSpoke));
        usdc.transfer(carol, 5e6); // simulate a shortfall: 5 left < 10
        opSpoke.retryFailedRelease(0);
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.Queued));
        _fund(opSpoke, 5e6);
        opSpoke.processQueue(1);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    // =============================================================== rebalance
    function test_rebalance_burns_andIsIdempotent() public {
        _fund(opSpoke, 100e6);
        uint256 supply = usdc.totalSupply();
        vm.expectEmit(address(tm));
        emit IMockTokenMessengerV2.DepositForBurn(
            0, address(usdc), 40e6, address(opSpoke), bytes32(uint256(uint160(address(0xBEEF)))), 3, 0, 2000
        );
        vm.expectEmit(address(opSpoke));
        emit ISpoke.RebalanceBurn(7, 40e6, 3, bytes32(uint256(uint160(address(0xBEEF)))));
        _deliverOp(_rebalance(7, 40e6));
        assertEq(usdc.balanceOf(address(opSpoke)), 60e6);
        assertEq(usdc.totalSupply(), supply - 40e6);
        assertEq(usdc.allowance(address(opSpoke), address(tm)), 0);

        _deliverOp(_rebalance(7, 40e6));
        assertEq(usdc.balanceOf(address(opSpoke)), 60e6);
        assertEq(uint8(opSpoke.rebalanceState(7)), uint8(ISpoke.ReleaseState.Executed));
    }

    function test_rebalance_queued_thenProcessed() public {
        _fund(opSpoke, 10e6);
        _deliverOp(_rebalance(1, 30e6));
        assertEq(uint8(opSpoke.rebalanceState(1)), uint8(ISpoke.ReleaseState.Queued));
        _deliverOp(_release(0, alice, 5e6)); // 10 < 30 + 5: queued behind the burn
        assertEq(opSpoke.queueLength(), 2);
        _fund(opSpoke, 25e6); // 35
        opSpoke.processQueue(10);
        assertEq(uint8(opSpoke.rebalanceState(1)), uint8(ISpoke.ReleaseState.Executed));
        assertEq(usdc.balanceOf(alice), 5e6);
        assertEq(usdc.balanceOf(address(opSpoke)), 0);
    }

    function test_rebalance_cctpFailure_failed_thenRetry() public {
        _fund(opSpoke, 100e6);
        vm.mockCallRevert(address(tm), abi.encodePacked(IMockTokenMessengerV2.depositForBurn.selector), bytes("paused"));
        _deliverOp(_rebalance(2, 40e6));
        assertEq(uint8(opSpoke.rebalanceState(2)), uint8(ISpoke.ReleaseState.Failed));
        assertEq(opSpoke.failedAmount(), 40e6);
        assertEq(usdc.allowance(address(opSpoke), address(tm)), 0);
        vm.expectRevert(abi.encodeWithSelector(Spoke.RebalanceBurnFailed.selector, bytes("paused")));
        opSpoke.retryFailedRebalance(2);
        vm.clearMockedCalls();
        opSpoke.retryFailedRebalance(2);
        assertEq(uint8(opSpoke.rebalanceState(2)), uint8(ISpoke.ReleaseState.Executed));
        assertEq(usdc.balanceOf(address(opSpoke)), 60e6);
        vm.expectRevert(ISpoke.NotFailed.selector);
        opSpoke.retryFailedRebalance(2);
    }

    function test_rebalance_revertingMessengerNeverRevertsDelivery() public {
        SpokeConfig memory c = _cfg(arbAdapter, address(new RevertingTokenMessenger()));
        ArbitrumSpoke s = new ArbitrumSpoke(c);
        _fund(s, 10e6);
        vm.prank(AddressAliasHelper.applyL1ToL2Alias(arbAdapter));
        s.receiveFromHub(_rebalance(0, 5e6));
        assertEq(uint8(s.rebalanceState(0)), uint8(ISpoke.ReleaseState.Failed));
    }

    // =============================================================== pause
    function test_pause_blocksDepositsOnly() public {
        _fund(opSpoke, 100e6);
        vm.expectEmit(address(opSpoke));
        emit ISpoke.DepositsPausedSet(true);
        _deliverOp(_pause(true));
        assertTrue(opSpoke.depositsPaused());
        vm.prank(user);
        vm.expectRevert(ISpoke.DepositsPaused.selector);
        opSpoke.deposit(MIN_DEP, 1, "");
        // releases and checkpoints keep working
        _deliverOp(_release(0, alice, 1e6));
        assertEq(usdc.balanceOf(alice), 1e6);
        opSpoke.sendCheckpoint();
        _deliverOp(_pause(false));
        _deposit(opSpoke, MIN_DEP);

        _deliverArb(_pause(true));
        assertTrue(arbSpoke.depositsPaused());
    }

    // =============================================================== malformed (never revert)
    function test_malformed_neverReverts() public {
        _fund(opSpoke, 100e6);
        _deliverOp(hex"deadbeef");
        _deliverOp("");
        _deliverOp(abi.encode(uint8(9), bytes("x")));
        _deliverOp(abi.encode(uint256(300), bytes(""))); // kind does not fit uint8
        _deliverOp(abi.encode(MSG_RELEASE, hex"0102"));
        _deliverOp(abi.encode(uint8(3), abi.encode(uint256(2)))); // bool out of range
        _deliverOp(abi.encode(uint8(2), hex"00"));
        assertEq(usdc.balanceOf(address(opSpoke)), 100e6);
        assertFalse(opSpoke.depositsPaused());

        vm.expectEmit(address(arbSpoke));
        emit ISpoke.HubMessageIgnored(9, abi.encodeWithSelector(Spoke.UnknownKind.selector, 9));
        _deliverArb(abi.encode(uint8(9), bytes("x")));
    }

    // =============================================================== authentication (I8)
    function test_auth_op_directCallers() public {
        _fund(opSpoke, 100e6);
        bytes memory m = _release(0, alice, 1e6);
        vm.expectRevert(ISpoke.NotFromHub.selector);
        opSpoke.receiveFromHub(m);
        vm.prank(opAdapter); // the adapter itself on L2 is not the bridge
        vm.expectRevert(ISpoke.NotFromHub.selector);
        opSpoke.receiveFromHub(m);
        vm.prank(address(l2m)); // the messenger outside a relay: xDomainMessageSender reverts
        vm.expectRevert(MockCrossDomainMessenger.NotInRelay.selector);
        opSpoke.receiveFromHub(m);
    }

    function test_auth_op_wrongXDomainSender() public {
        _fund(opSpoke, 100e6);
        assertFalse(_deliverOp(makeAddr("attacker"), _release(0, alice, 1e6)));
        assertFalse(_deliverOp(address(arbAdapter), _release(0, alice, 1e6)));
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(uint8(opSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.None));
    }

    function test_auth_op_wrongMessenger() public {
        _fund(opSpoke, 100e6);
        MockCrossDomainMessenger rogue = new MockCrossDomainMessenger(address(this));
        bytes memory data = abi.encodeCall(ISpoke.receiveFromHub, (_release(0, alice, 1e6)));
        rogue.relayMessage(0, opAdapter, address(opSpoke), data, 1_000_000);
        assertTrue(rogue.failedMessages(rogue.hashMessage(0, opAdapter, address(opSpoke), data)));
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_auth_arb_unaliasedAndOthers() public {
        _fund(arbSpoke, 100e6);
        bytes memory m = _release(0, alice, 1e6);
        address[4] memory bad = [
            arbAdapter, // unaliased
            AddressAliasHelper.applyL1ToL2Alias(opAdapter),
            AddressAliasHelper.undoL1ToL2Alias(arbAdapter),
            address(this)
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(ISpoke.NotFromHub.selector);
            arbSpoke.receiveFromHub(m);
        }
    }

    /// I8 fuzz: no address other than the canonical origin moves funds, burns or pauses.
    function testFuzz_auth_onlyCanonical(address caller, uint8 kindSel) public {
        vm.assume(caller != AddressAliasHelper.applyL1ToL2Alias(arbAdapter));
        vm.assume(caller != address(l2m));
        _fund(arbSpoke, 100e6);
        _fund(opSpoke, 100e6);
        bytes memory m = kindSel % 3 == 0 ? _release(0, alice, 1e6) : kindSel % 3 == 1 ? _rebalance(0, 1e6) : _pause(true);
        vm.prank(caller);
        vm.expectRevert(ISpoke.NotFromHub.selector);
        arbSpoke.receiveFromHub(m);
        vm.prank(caller);
        vm.expectRevert(ISpoke.NotFromHub.selector);
        opSpoke.receiveFromHub(m);
        assertEq(usdc.balanceOf(address(arbSpoke)), 100e6);
        assertEq(usdc.balanceOf(address(opSpoke)), 100e6);
        assertFalse(arbSpoke.depositsPaused() || opSpoke.depositsPaused());
    }

    function test_insufficientGas_revertsSoDeliveryIsReplayable() public {
        _fund(arbSpoke, 100e6);
        bytes memory m = _release(0, alice, 1e6);
        vm.prank(AddressAliasHelper.applyL1ToL2Alias(arbAdapter));
        vm.expectRevert(Spoke.InsufficientGas.selector);
        arbSpoke.receiveFromHub{gas: 150_000}(m);
        assertEq(uint8(arbSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.None));
        _deliverArb(m);
        assertEq(usdc.balanceOf(alice), 1e6);
    }

    // =============================================================== gas (PRD 7.10 L2 row)
    function test_gas_l2Operations() public {
        _fund(opSpoke, 1000e6);
        _deposit(opSpoke, MIN_DEP); // warm the first slot writes of the counters
        vm.prank(user);
        uint256 g = gasleft();
        opSpoke.deposit(5e6, 12345, new bytes(128));
        emit log_named_uint("gas: L2 deposit (128-byte note)", g - gasleft());

        opSpoke.sendCheckpoint(); // flush
        vm.roll(block.number + 1);
        _deposit(opSpoke, MIN_DEP);
        g = gasleft();
        opSpoke.sendCheckpoint();
        uint256 one = g - gasleft();
        emit log_named_uint("gas: sendCheckpoint, 1 item", one);
        for (uint256 i; i < MAX_CP; ++i) {
            _deposit(opSpoke, MIN_DEP);
        }
        g = gasleft();
        opSpoke.sendCheckpoint();
        uint256 four = g - gasleft();
        emit log_named_uint("gas: sendCheckpoint, 4 items", four);
        emit log_named_uint("gas: sendCheckpoint, per extra item", (four - one) / 3);

        bytes memory m = _release(0, alice, 10e6);
        _fund(arbSpoke, 100e6);
        vm.prank(AddressAliasHelper.applyL1ToL2Alias(arbAdapter));
        g = gasleft();
        arbSpoke.receiveFromHub(m);
        emit log_named_uint("gas: release execution (receiveFromHub, Arbitrum)", g - gasleft());
    }
}
