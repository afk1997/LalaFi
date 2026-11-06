// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FastlaneBase} from "./FastlaneBase.sol";
import {IStakeManager} from "../../src/interfaces/IStakeManager.sol";
import {StakeManager} from "../../src/hub/StakeManager.sol";
import {StakeManagerConfig} from "../../src/libraries/DeployConfig.sol";
import {MAX_VALIDATORS} from "../../src/libraries/Types.sol";

contract StakeManagerTest is FastlaneBase {
    address internal op = makeAddr("op");
    address internal signer = makeAddr("signer");

    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(sm), type(uint256).max);
    }

    function _ids(uint32 a) internal pure returns (uint32[] memory r) {
        r = new uint32[](1);
        r[0] = a;
    }

    function _xs(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    // ================================================================== config

    function test_constructor_rejectsBadConfig() public {
        StakeManagerConfig memory c = _smConfig();
        c.depositManager = address(dm);
        c.kNum = 1;
        c.kDen = 2; // k < 1
        vm.expectRevert(StakeManager.BadConfig.selector);
        new StakeManager(c);
        c = _smConfig();
        c.depositManager = address(dm);
        c.unbondSeconds = EPOCH; // shorter than the grace window
        vm.expectRevert(StakeManager.BadConfig.selector);
        new StakeManager(c);
        c = _smConfig();
        c.depositManager = address(dm);
        c.thetaNum = 4;
        c.thetaDen = 3;
        vm.expectRevert(StakeManager.BadConfig.selector);
        new StakeManager(c);
    }

    function test_views_params() public view {
        (uint256 kn, uint256 kd) = sm.k();
        assertEq(kn, 3);
        assertEq(kd, 2);
        (uint256 tn, uint256 td) = sm.theta();
        assertEq(tn, 2);
        assertEq(td, 3);
        assertEq(sm.sMin(), SMIN);
        assertEq(sm.currentEpoch(), 0);
        assertEq(sm.epochStart(0), uint64(block.timestamp));
    }

    // ================================================================== register

    function test_register() public {
        vm.expectEmit(address(sm));
        emit IStakeManager.Registered(1, op, signer);
        vm.prank(op);
        sm.register(signer);
        (uint32 id, bool active, bool jailed) = sm.validatorBySigner(signer);
        assertEq(id, 1);
        assertFalse(active);
        assertFalse(jailed);
        assertEq(sm.operatorOf(1), op);
        assertEq(sm.signerOf(1), signer);
    }

    function test_register_reverts() public {
        vm.startPrank(op);
        vm.expectRevert(IStakeManager.BadSigner.selector);
        sm.register(address(0));
        vm.expectRevert(IStakeManager.BadSigner.selector);
        sm.register(op);
        sm.register(signer);
        vm.expectRevert(IStakeManager.AlreadyRegistered.selector);
        sm.register(makeAddr("s2"));
        vm.stopPrank();
        // signer reuse / operator reuse as signer
        vm.prank(makeAddr("op2"));
        vm.expectRevert(IStakeManager.AlreadyRegistered.selector);
        sm.register(signer);
        vm.prank(makeAddr("op3"));
        vm.expectRevert(IStakeManager.AlreadyRegistered.selector);
        sm.register(op);
    }

    function test_register_jailedAddressesBlocked() public {
        (uint32 id,) = _addValidator(SMIN, 0, 0);
        address jop = operators[0];
        address jsg = vm.addr(pks[0]);
        vm.prank(address(dm));
        sm.slash(id, 3, address(0), 0);
        assertTrue(sm.isJailedAddress(jop) && sm.isJailedAddress(jsg));
        vm.prank(jop);
        vm.expectRevert(IStakeManager.Jailed.selector);
        sm.register(makeAddr("fresh"));
        vm.prank(makeAddr("fresh2"));
        vm.expectRevert(IStakeManager.Jailed.selector);
        sm.register(jsg);
        // jailed operator can't bond / allocate / unbond
        vm.startPrank(jop);
        vm.expectRevert(IStakeManager.Jailed.selector);
        sm.bond(1);
        vm.expectRevert(IStakeManager.Jailed.selector);
        sm.requestUnbond(1);
        vm.expectRevert(IStakeManager.NothingToWithdraw.selector);
        sm.withdrawUnbonded();
        vm.stopPrank();
    }

    // ================================================================== bond / activation

    function test_bond_effectiveNextEpoch() public {
        _fund(op, SMIN);
        vm.startPrank(op);
        vm.expectRevert(IStakeManager.NotRegistered.selector);
        sm.bond(SMIN);
        sm.register(signer);
        vm.expectRevert(IStakeManager.ZeroAmount.selector);
        sm.bond(0);
        vm.expectRevert(IStakeManager.BelowMinBond.selector);
        sm.bond(SMIN - 1);
        vm.expectEmit(address(sm));
        emit IStakeManager.Bonded(1, SMIN);
        sm.bond(SMIN);
        _setAlloc(SMIN, 0);
        vm.stopPrank();
        assertEq(sm.bondedOf(1), SMIN);
        assertEq(usdc.balanceOf(address(sm)), SMIN);
        (, bool active,) = sm.validatorBySigner(signer);
        assertFalse(active);
        assertEq(sm.allocation(1, BASE, 0), 0);

        vm.expectRevert(IStakeManager.EpochNotDue.selector);
        sm.advanceEpoch();
        vm.warp(block.timestamp + EPOCH);
        vm.expectEmit(address(sm));
        emit IStakeManager.Activated(1, 1);
        sm.advanceEpoch();
        (, active,) = sm.validatorBySigner(signer);
        assertTrue(active);
        assertEq(sm.currentEpoch(), 1);
        assertEq(sm.allocation(1, BASE, 1), SMIN);
        assertEq(sm.totalAllocation(BASE, 1), SMIN);
        assertEq(sm.activeValidators().length, 1);
    }

    function test_topUpBondWhileActive() public {
        (uint32 id,) = _addValidator(SMIN, SMIN, 0);
        _advance();
        usdc.mint(operators[0], 50e6);
        vm.prank(operators[0]);
        sm.bond(50e6);
        assertEq(sm.bondedOf(id), SMIN + 50e6);
        assertEq(sm.candidates().length, 0); // active validators are not queued
    }

    // ================================================================== allocations

    function test_setAllocations() public {
        (uint32 id,) = _addValidator(1_000e6, 0, 0);
        vm.startPrank(operators[0]);
        uint64[] memory cs = new uint64[](1);
        cs[0] = BASE;
        uint256[] memory as_ = new uint256[](2);
        vm.expectRevert(IStakeManager.LengthMismatch.selector);
        sm.setAllocations(cs, as_);
        cs = new uint64[](2);
        cs[0] = BASE;
        cs[1] = BASE;
        vm.expectRevert(IStakeManager.LengthMismatch.selector);
        sm.setAllocations(cs, as_);
        cs[1] = 77;
        vm.expectRevert(abi.encodeWithSelector(IStakeManager.UnsupportedChain.selector, uint64(77)));
        sm.setAllocations(cs, as_);
        vm.expectRevert(IStakeManager.OverAllocated.selector);
        _setAlloc(600e6, 400e6 + 1);
        vm.expectEmit(address(sm));
        emit IStakeManager.AllocationsSet(id, 1);
        _setAlloc(600e6, 400e6);
        vm.stopPrank();
        (uint256 b, uint256 a) = sm.pendingAllocations(id);
        assertEq(b, 600e6);
        assertEq(a, 400e6);
        _advance();
        assertEq(sm.allocation(id, BASE, 1), 600e6);
        assertEq(sm.allocation(id, ARB, 1), 400e6);
        assertEq(sm.totalAllocation(ARB, 1), 400e6);
    }

    function test_setAllocations_coverageRule() public {
        (uint32 id,) = _addValidator(1_000e6, 600e6, 0);
        _advance();
        vm.prank(address(dm));
        sm.addExposure(_ids(id), BASE, _xs(300e6)); // needs ≥ 450e6 on BASE
        vm.startPrank(operators[0]);
        vm.expectRevert(IStakeManager.ExposureNotCovered.selector);
        _setAlloc(450e6 - 1, 0);
        _setAlloc(450e6, 0);
        vm.stopPrank();
    }

    function test_snapshotDefersDecreaseWhileExposed() public {
        (uint32 id,) = _addValidator(1_000e6, 600e6, 0);
        _advance();
        // pending decrease to 300 scheduled first, exposure added after (still within epoch 1)
        vm.prank(operators[0]);
        _setAlloc(300e6, 0);
        vm.prank(address(dm));
        sm.addExposure(_ids(id), BASE, _xs(400e6)); // k·e = 600e6
        _advance();
        assertEq(sm.allocation(id, BASE, 2), 600e6); // deferred: max(300, ceil(1.5·400))
        vm.prank(address(dm));
        sm.clearExposure(_ids(id), BASE, _xs(400e6));
        _advance();
        assertEq(sm.allocation(id, BASE, 3), 300e6);
    }

    // ================================================================== unbond / withdraw

    function test_unbondAndWithdraw() public {
        (uint32 id,) = _addValidator(1_000e6, 600e6, 400e6);
        _advance();
        vm.startPrank(operators[0]);
        vm.expectRevert(IStakeManager.ZeroAmount.selector);
        sm.requestUnbond(0);
        vm.expectRevert(StakeManager.InsufficientBond.selector);
        sm.requestUnbond(1_000e6 + 1);
        vm.expectRevert(IStakeManager.NothingToWithdraw.selector);
        sm.withdrawUnbonded();
        vm.expectEmit(address(sm));
        emit IStakeManager.UnbondRequested(id, 500e6, uint64(block.timestamp) + UNBOND);
        sm.requestUnbond(500e6);
        vm.stopPrank();
        // pending allocations scaled to fit the remaining bond
        (uint256 b, uint256 a) = sm.pendingAllocations(id);
        assertEq(b, 300e6);
        assertEq(a, 200e6);
        (uint256 amt, uint64 unlock) = sm.unbondingOf(id);
        assertEq(amt, 500e6);
        assertEq(sm.bondedOf(id), 500e6);
        assertEq(sm.totalStake(), 1_000e6); // still slashable

        vm.prank(operators[0]);
        vm.expectRevert(IStakeManager.StillLocked.selector);
        sm.withdrawUnbonded();
        vm.warp(unlock);
        vm.prank(operators[0]);
        sm.withdrawUnbonded();
        assertEq(usdc.balanceOf(operators[0]), 500e6);
        assertEq(sm.totalStake(), 500e6);
    }

    function test_unbondBelowMin_leavesActiveSet() public {
        (uint32 id,) = _addValidator(SMIN, SMIN, 0);
        _advance();
        vm.prank(operators[0]);
        sm.requestUnbond(1);
        _advance();
        (, bool active,) = sm.validatorBySigner(vm.addr(pks[0]));
        assertFalse(active);
        assertEq(sm.allocation(id, BASE, 2), 0);
        assertEq(sm.activeValidators().length, 0);
    }

    function test_withdraw_blockedByExposure_I10() public {
        (uint32 id,) = _addValidator(1_000e6, 1_000e6, 0);
        _advance();
        vm.prank(address(dm));
        sm.addExposure(_ids(id), BASE, _xs(600e6)); // k·e = 900e6
        vm.prank(operators[0]);
        sm.requestUnbond(1_000e6);
        vm.warp(block.timestamp + UNBOND + 1);
        _advanceNoWarp();
        vm.prank(operators[0]);
        vm.expectRevert(IStakeManager.ExposureNotCovered.selector);
        sm.withdrawUnbonded();
        // also after many epochs: time never clears exposure
        for (uint256 i; i < 5; ++i) {
            _advance();
        }
        vm.prank(operators[0]);
        vm.expectRevert(IStakeManager.ExposureNotCovered.selector);
        sm.withdrawUnbonded();
        // canonical confirmation clears it
        vm.prank(address(dm));
        sm.clearExposure(_ids(id), BASE, _xs(600e6));
        vm.prank(operators[0]);
        sm.withdrawUnbonded();
        assertEq(usdc.balanceOf(operators[0]), 1_000e6);
    }

    function test_addExposure_globalCoverage() public {
        (uint32 id,) = _addValidator(900e6, 900e6, 0);
        _advance();
        vm.startPrank(address(dm));
        sm.addExposure(_ids(id), BASE, _xs(500e6));
        sm.addExposure(_ids(id), ARB, _xs(100e6)); // Σe = 600 = 900/1.5
        vm.expectRevert(IStakeManager.ExposureNotCovered.selector);
        sm.addExposure(_ids(id), ARB, _xs(1));
        vm.expectRevert(IStakeManager.LengthMismatch.selector);
        sm.addExposure(_ids(id), ARB, new uint256[](0));
        vm.expectRevert(abi.encodeWithSelector(IStakeManager.UnsupportedChain.selector, uint64(1)));
        sm.addExposure(_ids(id), 1, _xs(1));
        vm.expectRevert(IStakeManager.NotRegistered.selector);
        sm.addExposure(_ids(99), BASE, _xs(1));
        // clear saturates
        sm.clearExposure(_ids(id), ARB, _xs(1_000e6));
        vm.stopPrank();
        assertEq(sm.exposure(id, ARB), 0);
        assertEq(sm.exposure(id, BASE), 500e6);
    }

    function test_onlyDepositManager() public {
        vm.expectRevert(IStakeManager.OnlyDepositManager.selector);
        sm.addExposure(_ids(1), BASE, _xs(1));
        vm.expectRevert(IStakeManager.OnlyDepositManager.selector);
        sm.clearExposure(_ids(1), BASE, _xs(1));
        vm.expectRevert(IStakeManager.OnlyDepositManager.selector);
        sm.slash(1, 1, address(this), 0);
    }

    // ================================================================== slashing

    function test_slash_math() public {
        (uint32 id,) = _addValidator(1_000e6, 1_000e6, 0);
        _advance();
        vm.prank(operators[0]);
        sm.requestUnbond(200e6); // Σ = 800 bonded + 200 unbonding
        vm.prank(address(dm));
        sm.addExposure(_ids(id), BASE, _xs(600e6));
        address prover = makeAddr("prover");
        vm.expectEmit(address(sm));
        emit IStakeManager.Slashed(id, 1_000e6, 1, prover, 100e6);
        vm.prank(address(dm));
        uint256 s = sm.slash(id, 1, prover, 600e6);
        assertEq(s, 1_000e6);
        assertEq(usdc.balanceOf(prover), 100e6); // ω·Σ < Σ − loss
        assertEq(lm.totalSlashedReceived(), 900e6);
        assertEq(lm.insurance(), 900e6);
        assertEq(usdc.balanceOf(address(lm)), 900e6);
        assertEq(sm.bondedOf(id), 0);
        (uint256 u,) = sm.unbondingOf(id);
        assertEq(u, 0);
        assertEq(sm.exposure(id, BASE), 0);
        assertEq(sm.totalStake(), 0);
        assertEq(sm.activeValidators().length, 0);
        (, bool active, bool jailed) = sm.validatorBySigner(vm.addr(pks[0]));
        assertFalse(active);
        assertTrue(jailed);
        // second slash is a no-op
        vm.prank(address(dm));
        assertEq(sm.slash(id, 1, prover, 600e6), 0);
    }

    function test_slash_rewardCappedByLoss() public {
        (uint32 id,) = _addValidator(1_000e6, 1_000e6, 0);
        _advance();
        address prover = makeAddr("prover");
        vm.prank(address(dm));
        sm.slash(id, 1, prover, 950e6); // Σ − loss = 50 < ω·Σ = 100
        assertEq(usdc.balanceOf(prover), 50e6);
        assertEq(lm.totalSlashedReceived(), 950e6);
    }

    function test_slash_usesOpenExposureWhenLarger() public {
        // equivocation passes coveredLoss = 0, but the validator still owes its open exposure
        (uint32 id,) = _addValidator(1_000e6, 1_000e6, 0);
        _advance();
        vm.prank(address(dm));
        sm.addExposure(_ids(id), BASE, _xs(660e6));
        address prover = makeAddr("prover");
        vm.prank(address(dm));
        sm.slash(id, 3, prover, 0);
        assertEq(usdc.balanceOf(prover), 100e6);
        assertGe(lm.totalSlashedReceived(), 660e6);
    }

    function test_slash_blacklistedProverFallsBackToInsurance() public {
        (uint32 id,) = _addValidator(1_000e6, 1_000e6, 0);
        _advance();
        address prover = makeAddr("prover");
        usdc.setBlacklisted(prover, true);
        vm.prank(address(dm));
        sm.slash(id, 1, prover, 0);
        assertEq(lm.totalSlashedReceived(), 1_000e6);
    }

    function test_slash_forfeitsRewards() public {
        _addValidator(1_000e6, 1_000e6, 0);
        _addValidator(1_000e6, 1_000e6, 0);
        _advance();
        _fundPot(100e6);
        _advance();
        assertEq(sm.pendingRewards(vids[0]), 50e6);
        vm.prank(address(dm));
        sm.slash(vids[0], 1, address(0), 0);
        assertEq(sm.pendingRewards(vids[0]), 0);
        assertEq(sm.undistributedRewards(), 50e6);
        _advance();
        assertEq(sm.pendingRewards(vids[1]), 100e6);
    }

    // ================================================================== registry / eviction

    function test_registryFull_eviction() public {
        for (uint256 i; i < MAX_VALIDATORS; ++i) {
            _addValidator(SMIN + i * 1e6, SMIN, 0);
        }
        _advance();
        assertEq(sm.activeValidators().length, MAX_VALIDATORS);
        // smallest active bond = SMIN (vids[0]); margin 1% → needs > 101e6
        (uint32 weak,) = _addValidator(101e6, 0, 0);
        _advance();
        (, bool active,) = sm.validatorBySigner(vm.addr(pks[MAX_VALIDATORS]));
        assertFalse(active);
        assertEq(sm.candidates().length, 0); // dropped from the queue

        usdc.mint(operators[MAX_VALIDATORS], 1);
        vm.prank(operators[MAX_VALIDATORS]);
        sm.bond(1); // 101e6 + 1 > 101e6 → re-queued and wins
        vm.expectEmit(address(sm));
        emit IStakeManager.Evicted(vids[0], weak);
        _advance();
        (, active,) = sm.validatorBySigner(vm.addr(pks[MAX_VALIDATORS]));
        assertTrue(active);
        (, bool evActive,) = sm.validatorBySigner(vm.addr(pks[0]));
        assertFalse(evActive);
        assertEq(sm.activeValidators().length, MAX_VALIDATORS);
        // evicted stake moved to unbonding, still slashable
        assertEq(sm.bondedOf(vids[0]), 0);
        (uint256 u,) = sm.unbondingOf(vids[0]);
        assertEq(u, SMIN);
        assertEq(sm.allocation(vids[0], BASE, sm.currentEpoch()), 0);
        vm.prank(address(dm));
        assertEq(sm.slash(vids[0], 1, address(0), 0), SMIN);
    }

    function test_eviction_strongestFirst() public {
        for (uint256 i; i < MAX_VALIDATORS; ++i) {
            _addValidator(SMIN, SMIN, 0);
        }
        _advance();
        (uint32 a,) = _addValidator(200e6, 0, 0);
        (uint32 b,) = _addValidator(300e6, 0, 0);
        _advance();
        assertTrue(_isActive(a));
        assertTrue(_isActive(b));
        assertEq(sm.activeValidators().length, MAX_VALIDATORS);
    }

    function test_evictedExposureBlocksWithdraw() public {
        for (uint256 i; i < MAX_VALIDATORS; ++i) {
            _addValidator(SMIN, SMIN, 0);
        }
        _advance();
        vm.prank(address(dm));
        sm.addExposure(_ids(vids[0]), BASE, _xs(50e6));
        _addValidator(500e6, 0, 0);
        _advance();
        // vids[0] (index 0 among equal minimums) was evicted
        assertFalse(_isActive(vids[0]));
        vm.warp(block.timestamp + UNBOND);
        vm.prank(operators[0]);
        vm.expectRevert(IStakeManager.ExposureNotCovered.selector);
        sm.withdrawUnbonded();
    }

    function test_candidateQueue_boundedAndReplaceable() public {
        uint256 cap = sm.MAX_CANDIDATES();
        for (uint256 i; i < cap; ++i) {
            _addValidator(SMIN, 0, 0);
        }
        assertEq(sm.candidates().length, cap);
        // equal bond can't displace anyone
        address o = makeAddr("late");
        _fund(o, 1_000e6);
        vm.startPrank(o);
        sm.register(makeAddr("lateSigner"));
        vm.expectRevert(IStakeManager.RegistryFull.selector);
        sm.bond(SMIN);
        sm.bond(SMIN + 1); // larger bond replaces the weakest queued candidate
        vm.stopPrank();
        assertEq(sm.candidates().length, cap);
        _advance();
        assertTrue(_isActive(sm.idByOperator(o)));
        assertEq(sm.activeValidators().length, MAX_VALIDATORS);
    }

    // ================================================================== rewards

    function _fundPot(uint256 amt) internal {
        usdc.mint(address(this), amt);
        usdc.approve(address(lm), amt);
        lm.fundRewardPot(amt);
    }

    function test_rewards_proRata() public {
        _addValidator(1_000e6, 600e6, 400e6); // 1000 allocated
        _addValidator(1_000e6, 300e6, 0); // 300
        _addValidator(1_000e6, 0, 0); // 0
        _advance();
        _fundPot(130e6 + 1);
        vm.expectEmit(address(sm));
        emit IStakeManager.RewardsDistributed(1, 130e6);
        _advance();
        assertEq(sm.pendingRewards(vids[0]), 100e6);
        assertEq(sm.pendingRewards(vids[1]), 30e6);
        assertEq(sm.pendingRewards(vids[2]), 0);
        assertEq(sm.undistributedRewards(), 1); // dust carried
        vm.prank(operators[0]);
        sm.claimRewards();
        assertEq(usdc.balanceOf(operators[0]), 100e6);
        vm.prank(operators[2]);
        vm.expectRevert(IStakeManager.NothingToWithdraw.selector);
        sm.claimRewards();
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(IStakeManager.NotRegistered.selector);
        sm.claimRewards();
    }

    function test_rewards_noStakeCarriesPot() public {
        _fundPot(10e6);
        _advance();
        assertEq(sm.undistributedRewards(), 10e6);
        _addValidator(SMIN, SMIN, 0);
        _advance(); // epoch 1 snapshot taken now; pot of epoch 1 distributed at next advance
        _advance();
        assertEq(sm.pendingRewards(vids[0]), 10e6);
        assertEq(sm.undistributedRewards(), 0);
    }

    function test_rewards_potFailureDoesNotBlockEpoch() public {
        lm.setRevertTakePot(true);
        _advance();
        assertEq(sm.currentEpoch(), 1);
    }

    // ================================================================== helpers

    function _isActive(uint32 id) internal view returns (bool a) {
        (, a,) = sm.validatorBySigner(sm.signerOf(id));
    }

    function _advanceNoWarp() internal {
        sm.advanceEpoch();
    }
}
