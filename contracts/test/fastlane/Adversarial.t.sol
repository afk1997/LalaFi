// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FastlaneBase} from "./FastlaneBase.sol";
import {IDepositManager} from "../../src/interfaces/IDepositManager.sol";
import {IStakeManager} from "../../src/interfaces/IStakeManager.sol";
import {L2Deposit} from "../../src/libraries/Types.sol";
import {MockLiquidityManager} from "./mocks/FastlaneMocks.sol";

/// @notice PRD 15.5 rows owned by the fast lane.
contract AdversarialTest is FastlaneBase {
    uint256 internal constant N = 7;
    uint256 internal constant BOND = 20_000e6;
    uint256 internal constant ALLOC = 10_000e6;

    function setUp() public override {
        super.setUp();
        _addValidators(N, BOND, ALLOC, ALLOC);
        _advance();
    }

    function _allJailed() internal view returns (bool) {
        for (uint256 i; i < N; ++i) {
            (,, bool jailed) = sm.validatorBySigner(vm.addr(pks[i]));
            if (!jailed) return false;
        }
        return true;
    }

    /// 100% of validators sign fake deposits up to capacity, then spend them.
    /// Inserted fake value ≤ S/k; mismatch is proven at the checkpoint; all signers slashed;
    /// net protocol position ≥ 0.
    function test_fullCollusion_upToCapacity_mismatchAndAbsence() public {
        uint256 S = sm.totalAllocation(BASE, 1); // 70k
        uint256 cap = S * 2 / 3; // S/k
        // small real deposits on the spoke, attested with inflated amounts
        L2Deposit[] memory real = _spokeDeposits(BASE, 4, 1e6);
        uint256 fake;
        for (uint256 i; i < 4; ++i) {
            L2Deposit[] memory f = _one(L2Deposit(real[i].index, real[i].ownerDigest, 10_000e6, real[i].fee, real[i].l2Block));
            _attest(BASE, 1, f, _allPks());
            fake += 10_000e6;
        }
        // remaining capacity through a non-existent future index
        // per-validator headroom left by R3 (x_v rounds up, so fill exactly to floor(s/k))
        uint256 rem = ALLOC * 2 / 3 - sm.exposure(vids[0], BASE);
        uint256 last = rem * N;
        L2Deposit[] memory fut = _one(L2Deposit(100, 5, last, 0, spokes[BASE].l2Block));
        _attest(BASE, 1, fut, _allPks());
        fake += last;
        assertLe(fake, cap);
        // capacity is exhausted: one more unit fails R3
        L2Deposit[] memory more = _one(L2Deposit(101, 5, 1e6, 0, spokes[BASE].l2Block));
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, more, _allPks());
        vm.expectRevert();
        dm.submitAttestation(BASE, 1, more, s, g);

        // "spend": the fake value is withdrawn from the pool (modelled as a vault loss)
        uint256 vaultLoss = fake;

        // unbonding is useless now: stake backing exposure can't leave
        for (uint256 i; i < N; ++i) {
            vm.prank(operators[i]);
            sm.requestUnbond(BOND);
        }
        vm.warp(block.timestamp + UNBOND + 1);
        for (uint256 i; i < N; ++i) {
            vm.prank(operators[i]);
            vm.expectRevert(IStakeManager.ExposureNotCovered.selector);
            sm.withdrawUnbonded();
        }

        // canonical checkpoint: mismatch on batch 1, the others are then proven too
        _checkpointAll(BASE);
        assertTrue(_allJailed());
        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Fraud));
        // batches 2–4 mismatch too (each processed item slashes its own batch; signers already jailed)
        for (uint256 b = 2; b <= 4; ++b) {
            assertEq(uint8(dm.batchStatus(b)), uint8(IDepositManager.BatchStatus.Fraud));
        }
        // future index 100: absence via a later checkpoint
        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        dm.proveAbsence(BASE, seq, 5, fut, 0);
        assertEq(uint8(dm.batchStatus(5)), uint8(IDepositManager.BatchStatus.Fraud));
        assertEq(dm.unconfirmedFastValue(), 0);

        // net protocol position: slashed stake moved to insurance ≥ fake value spent
        uint256 recovered = lm.totalSlashedReceived();
        assertGe(recovered, vaultLoss);
        emit log_named_uint("fake value", vaultLoss);
        emit log_named_uint("recovered to insurance", recovered);
        // every honest depositor still got a true leaf
        for (uint256 i; i < 4; ++i) {
            assertTrue(dm.confirmed(BASE, uint64(i)));
        }
    }

    /// A coalition attests a non-existent future index → absence proven with an empty checkpoint.
    function test_absence_futureIndex_emptyCheckpoint() public {
        uint64 l2 = spokes[ARB].l2Block;
        L2Deposit[] memory fut = _one(L2Deposit(0, 9, 8_000e6, 0, l2));
        _attest(ARB, 1, fut, _pks(0, 5));
        (uint64 seq, ) = _sendCheckpoint(ARB, 64);
        assertEq(dm.checkpointOf(ARB, seq).countAtSend, 0);
        address watcher = makeAddr("watcher");
        vm.prank(watcher);
        dm.proveAbsence(ARB, seq, 1, fut, 0);
        for (uint256 i; i < 5; ++i) {
            (,, bool jailed) = sm.validatorBySigner(vm.addr(pks[i]));
            assertTrue(jailed);
        }
        (,, bool j5) = sm.validatorBySigner(vm.addr(pks[5]));
        assertFalse(j5); // non-signers untouched
        assertGe(lm.totalSlashedReceived(), 8_000e6);
        assertGt(usdc.balanceOf(watcher), 0);
    }

    /// A validator signs two different contents for one index → equivocation from gossip.
    function test_equivocation_fromGossip() public {
        L2Deposit memory d = _spokeDeposit(BASE, 50e6);
        L2Deposit[] memory a = _one(d);
        L2Deposit[] memory b = _one(L2Deposit(d.index, d.ownerDigest, d.amount, d.fee, d.l2Block + 1));
        bytes memory sa = _sig(pks[2], dm.batchDigest(BASE, 1, a));
        bytes memory sb = _sig(pks[2], dm.batchDigest(BASE, 1, b));
        dm.proveEquivocation(BASE, vm.addr(pks[2]), 1, a, sa, 0, 1, b, sb, 0);
        (,, bool jailed) = sm.validatorBySigner(vm.addr(pks[2]));
        assertTrue(jailed);
        assertEq(sm.bondedOf(vids[2]), 0);
    }

    /// A coalition tries to unbond before its fraud is proven → blocked (I10); later slashed.
    function test_unbondBeforeProof_blocked() public {
        L2Deposit[] memory real = _spokeDeposits(BASE, 1, 1e6);
        L2Deposit[] memory f = _one(L2Deposit(real[0].index, real[0].ownerDigest, 9_000e6, real[0].fee, real[0].l2Block));
        _attest(BASE, 1, f, _pks(0, 5));
        for (uint256 i; i < 5; ++i) {
            vm.prank(operators[i]);
            sm.requestUnbond(BOND);
        }
        for (uint256 e; e < 10; ++e) {
            _advance();
        }
        vm.warp(block.timestamp + UNBOND);
        for (uint256 i; i < 5; ++i) {
            vm.prank(operators[i]);
            vm.expectRevert(IStakeManager.ExposureNotCovered.selector);
            sm.withdrawUnbonded();
        }
        uint256 before = sm.totalStake();
        _checkpointAll(BASE);
        assertEq(sm.totalStake(), before - 5 * BOND);
        for (uint256 i; i < 5; ++i) {
            vm.prank(operators[i]);
            vm.expectRevert(IStakeManager.NothingToWithdraw.selector);
            sm.withdrawUnbonded();
        }
        assertGe(lm.totalSlashedReceived(), 9_000e6);
    }

    /// An LP rushes to exit while fast-lane value is unconfirmed → the valve blocks the excess.
    function test_lpExitValve() public {
        lm.setLpAssets(0);
        usdc.mint(address(this), 10_000e6);
        usdc.approve(address(lm), 10_000e6);
        lm.addLiquidity(10_000e6); // lpAssets = 10k, β = 1/2 → U ≤ 5k
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 4_000e6);
        _attest(BASE, 1, ds, _allPks());
        // U = 4k: LP may withdraw down to lpAssets = 8k
        vm.expectRevert(MockLiquidityManager.SafetyValve.selector);
        lm.removeLiquidity(2_000e6 + 1);
        lm.removeLiquidity(2_000e6);
        // a new attestation beyond the valve also fails
        L2Deposit[] memory ds2 = _spokeDeposits(BASE, 1, 1e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds2, _allPks());
        vm.expectRevert(IDepositManager.SafetyValve.selector);
        dm.submitAttestation(BASE, 1, ds2, s, g);
        // after confirmation the valve releases
        _checkpointAll(BASE);
        assertEq(dm.unconfirmedFastValue(), 0);
        lm.removeLiquidity(8_000e6);
    }
}
