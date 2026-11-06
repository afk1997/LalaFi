// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FastlaneBase} from "./FastlaneBase.sol";
import {FastlaneHandler} from "./handlers/FastlaneHandler.sol";
import {IDepositManager} from "../../src/interfaces/IDepositManager.sol";

/// @notice I5, I6, I10, I12 (PRD 15.3) under random honest / colluding behaviour.
contract FastlaneInvariants is StdInvariant, FastlaneBase {
    FastlaneHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new FastlaneHandler(dm, sm, usdc, lm, baseAdapter, arbAdapter);
        h.addValidator(30_000e6, 15_000e6, 15_000e6);
        h.addValidator(24_000e6, 18_000e6, 6_000e6);
        h.addValidator(18_000e6, 3_000e6, 15_000e6);
        h.addValidator(4_000e6, 4_000e6, 0);
        h.addValidator(3_000e6, 0, 3_000e6);
        h.addValidator(2_000e6, 1_000e6, 1_000e6);
        vm.warp(block.timestamp + EPOCH);
        sm.advanceEpoch();

        bytes4[] memory sel = new bytes4[](15);
        sel[0] = FastlaneHandler.deposit.selector;
        sel[1] = FastlaneHandler.attestHonest.selector;
        sel[2] = FastlaneHandler.attestFake.selector;
        sel[3] = FastlaneHandler.sendCheckpoint.selector;
        sel[4] = FastlaneHandler.processSome.selector;
        sel[5] = FastlaneHandler.proveAbsences.selector;
        sel[6] = FastlaneHandler.equivocate.selector;
        sel[7] = FastlaneHandler.newValidator.selector;
        sel[8] = FastlaneHandler.advance.selector;
        sel[9] = FastlaneHandler.unbond.selector;
        sel[10] = FastlaneHandler.withdraw.selector;
        sel[11] = FastlaneHandler.realloc.selector;
        sel[12] = FastlaneHandler.bondMore.selector;
        sel[13] = FastlaneHandler.setBuffers.selector;
        sel[14] = FastlaneHandler.attestHonest.selector; // weight honest traffic higher
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    /// I5: each (chain, index) confirmed at most once and credited to L[c] at most once:
    /// the ledger equals Σ (a + fee) over confirmed canonical deposits, and bounties never exceed fees.
    function invariant_I5_confirmedAndCreditedOnce() public view {
        uint256 feesTotal;
        uint64[2] memory cs = [BASE, ARB];
        for (uint256 k; k < 2; ++k) {
            (uint256 sum, uint256 fees, uint256 bad) = h.canonicalConfirmed(cs[k]);
            assertEq(bad, 0, "confirmed without canonical deposit / insertion");
            assertEq(lm.creditedByDM(cs[k]), sum, "L[c] credit != confirmed canonical value");
            feesTotal += fees;
        }
        assertLe(lm.totalClaimable(), feesTotal, "bounties exceed settlement fees");
    }

    /// unconfirmedFastValue == Σ A over Pending batches (never double-decremented).
    function invariant_unconfirmedFastValue() public view {
        uint256 n = dm.batchCount();
        uint256 sum;
        for (uint256 b = 1; b <= n; ++b) {
            (,, uint256 amount,,,, IDepositManager.BatchStatus st,,) = dm.batchInfo(b);
            if (st == IDepositManager.BatchStatus.Pending) sum += amount;
        }
        assertEq(dm.unconfirmedFastValue(), sum);
    }

    /// I6: k·e_v^c ≤ s_v^c for every active validator in the current epoch (and globally against stake).
    function invariant_I6_exposureCovered() public view {
        uint32 n = sm.validatorCount();
        uint64 cur = sm.currentEpoch();
        for (uint32 id = 1; id <= n; ++id) {
            (, bool active, bool jailed) = sm.validatorBySigner(sm.signerOf(id));
            uint256 eb = sm.exposure(id, BASE);
            uint256 ea = sm.exposure(id, ARB);
            if (jailed) {
                assertEq(eb + ea, 0);
                continue;
            }
            if (active) {
                assertLe(3 * eb, 2 * sm.allocation(id, BASE, cur), "I6 base");
                assertLe(3 * ea, 2 * sm.allocation(id, ARB, cur), "I6 arb");
            }
        }
    }

    /// I10: stake backing non-zero exposure can't be withdrawn:
    /// k·Σ_c e_v^c ≤ bonded + unbonding for every validator, and the stake is really held.
    function invariant_I10_stakeBacksExposure() public view {
        uint32 n = sm.validatorCount();
        uint256 total;
        for (uint32 id = 1; id <= n; ++id) {
            (uint256 u,) = sm.unbondingOf(id);
            uint256 stake = sm.bondedOf(id) + u;
            total += stake;
            assertLe(3 * (sm.exposure(id, BASE) + sm.exposure(id, ARB)), 2 * stake, "I10");
        }
        assertEq(total, sm.totalStake());
        assertGe(
            usdc.balanceOf(address(sm)), sm.totalStake() + sm.totalRewardsOwed() + sm.undistributedRewards(), "custody"
        );
    }

    /// Deterministic smoke run of the handler (guards against a handler that silently does nothing).
    function test_handlerSmoke() public {
        h.deposit(0, 100e6);
        h.deposit(0, 200e6);
        h.deposit(1, 300e6);
        h.attestHonest(0, 1, 0, false);
        h.attestFake(0, 0, 5_000e6, 0, false, false);
        h.attestFake(1, 1, 4_000e6, 0, true, false);
        h.attestFake(0, 2, 0, 0, false, false);
        assertEq(h.calls("attestHonest.ok"), 1);
        assertEq(h.calls("attestFake.ok"), 2); // the 3rd has no uninserted deposit left on BASE
        h.sendCheckpoint(0, 16);
        h.processSome(0, 1, false);
        h.advance(0);
        h.unbond(0, type(uint256).max);
        h.equivocate(5, 0);
        h.settleAll();
        assertGt(lm.totalSlashedReceived(), h.ghostFakeValue());
        assertEq(dm.unconfirmedFastValue(), 0);
        invariant_I5_confirmedAndCreditedOnce();
        invariant_I6_exposureCovered();
        invariant_I10_stakeBacksExposure();
        invariant_unconfirmedFastValue();
    }

    /// I12 (Theorem 9.4): after all fraud proofs, every fraudulent batch is slashed and the net
    /// protocol position is ≥ 0 (slashed stake moved to insurance ≥ fake value inserted).
    function afterInvariant() external {
        h.settleAll();
        uint256 n = h.fakeCount();
        for (uint256 i; i < n; ++i) {
            assertEq(
                uint8(dm.batchStatus(h.fakeBatchId(i))), uint8(IDepositManager.BatchStatus.Fraud), "unproven fraud"
            );
        }
        assertGe(lm.totalSlashedReceived(), h.ghostFakeValue(), "I12 net position < 0");
        // every batch settled: confirmed (honest) or slashed (fraud)
        assertEq(dm.unconfirmedFastValue(), 0, "batch left pending after settlement");
    }
}
