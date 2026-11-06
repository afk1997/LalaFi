// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoreBase} from "../utils/CoreBase.sol";
import {RefMerkle} from "../utils/RefMerkle.sol";
import {CoreHandler} from "./CoreHandler.sol";
import {Release, ROOT_HISTORY} from "../../../src/libraries/Types.sol";
import {CoreMockAdapter} from "../mocks/CoreMocks.sol";

/// @notice PRD 15.3 invariants owned by contracts-core: I1, I2, I3 (LiquidityManager part), I7, I9, I11.
///
/// I3 (LiquidityManager part) is checked as four precise statements. With no fast-lane fraud and
/// maxFee = 0 (the handler only models canonically confirmed deposits):
///   (a) ledger identity:  Σ_c L[c] == shieldedSupply + lpAssets + insurance + rewardPot + totalClaimable
///   (b) L1 vault:         USDC.balanceOf(LM) + M_ETH + B_ETH >= L[ETH]
///   (c) spokes (Lemma 11.2 / I4 model): V_c + M_c >= L[c] + Q_c, where V_c is the modelled spoke
///                          vault, M_c the CCTP mints in flight to c, Q_c the releases and rebalance
///                          burns reserved on the hub but still queued on the spoke.
///   In (b) and (c) B_c is the rebalance burns towards c that their source spoke has queued because
///   its own vault is waiting for an in-flight mint (L[c] is credited at order time, PRD 11.1). So
///   the per-chain form is V_c + M_c + B_c >= L[c] + Q_c; spokes MUST queue (not drop) a burn they
///   cannot fund yet, or B_c would be lost.
///   (d) LP claims:        previewRemove(totalSupply) <= lpAssets
/// Together: every liability (notes, LP assets, insurance, rewards, claimables) is backed by USDC
/// held or in flight, which is PRD 11.6 restricted to the state these contracts control.
contract CoreInvariants is CoreBase {
    CoreHandler internal handler;
    RefMerkle internal ref;

    function setUp() public override {
        super.setUp();
        ref = new RefMerkle(poseidon);
        handler = new CoreHandler(hub, lm, usdc, dm, sm, baseAdapter, arbAdapter, tm, ref, guardian);
        usdc.setBlacklisted(handler.blacklistedRelayer(), true);

        bytes4[] memory sels = new bytes4[](15);
        sels[0] = CoreHandler.depositEth.selector;
        sels[1] = CoreHandler.depositL2.selector;
        sels[2] = CoreHandler.transact.selector;
        sels[3] = CoreHandler.transact.selector; // weight spends up
        sels[4] = CoreHandler.resendRelease.selector;
        sels[5] = CoreHandler.addLiquidity.selector;
        sels[6] = CoreHandler.removeLiquidity.selector;
        sels[7] = CoreHandler.claim.selector;
        sels[8] = CoreHandler.slash.selector;
        sels[9] = CoreHandler.takeRewardPot.selector;
        sels[10] = CoreHandler.setUfv.selector;
        sels[11] = CoreHandler.rebalance.selector;
        sels[12] = CoreHandler.completeMint.selector;
        sels[13] = CoreHandler.guardianAct.selector;
        sels[14] = CoreHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// I1: no nullifier is accepted twice.
    function invariant_I1_noDoubleSpend() public view {
        assertFalse(handler.doubleAccept(), "nullifier accepted twice");
        assertEq(handler.reuseAttempts(), handler.reuseRejected(), "a reused nullifier went through");
        uint256 n = handler.spentNullifierCount();
        for (uint256 i; i < n; ++i) {
            uint256 nf = handler.spentNullifier(i);
            assertTrue(hub.isSpent(nf));
            assertEq(handler.nullifierAccepts(nf), 1);
        }
    }

    /// I2: shieldedSupply = Σ inserted deposit amounts − Σ v over spends.
    function invariant_I2_shieldedSupply() public view {
        assertEq(hub.shieldedSupply(), handler.ghostDeposited() - handler.ghostSpentV());
    }

    /// I3 (LiquidityManager part), see contract doc.
    function invariant_I3_lmSolvency() public view {
        uint256 sumL = lm.available(ETH) + lm.available(BASE) + lm.available(ARB);
        assertEq(sumL, lm.totalLiquidity());
        assertEq(
            sumL,
            hub.shieldedSupply() + lm.lpAssets() + lm.insurance() + lm.rewardPot() + lm.totalClaimable(),
            "(a) ledger identity"
        );
        assertGe(
            usdc.balanceOf(address(lm)) + handler.ghostInflight(ETH) + handler.queuedBurnTo(ETH),
            lm.available(ETH),
            "(b) L1 vault"
        );
        _checkSpoke(BASE);
        _checkSpoke(ARB);
        assertLe(lm.previewRemove(lm.totalSupply()), lm.lpAssets(), "(d) LP claims");
    }

    function _checkSpoke(uint64 c) internal view {
        assertGe(
            handler.ghostSpokeVault(c) + handler.ghostInflight(c) + handler.queuedBurnTo(c),
            lm.available(c) + handler.queuedReleases(c) + handler.queuedBurnTotal(c),
            "(c) spoke V + M + B >= L + Q"
        );
    }

    /// I7: release indices per destination are contiguous; each executes at most once on the spoke.
    function invariant_I7_releases() public view {
        _checkReleases(BASE, baseAdapter);
        _checkReleases(ARB, arbAdapter);
        assertEq(hub.releaseCount(ETH), 0);
    }

    function _checkReleases(uint64 dst, CoreMockAdapter a) internal view {
        uint64 n = hub.releaseCount(dst);
        assertEq(a.uniqueExecuted(), n, "every logged index delivered exactly once");
        for (uint64 i; i < n; ++i) {
            Release memory r = a.releaseAt(i);
            assertEq(r.index, i);
            assertEq(r.dstChainId, dst);
            assertEq(hub.releaseHash(dst, i), keccak256(abi.encode(r)));
            assertEq(a.execCount(i), 1);
        }
        assertEq(hub.releaseHash(dst, n), bytes32(0), "no gap after the last index");
    }

    /// I9: the guardian can't reduce any vault balance, and can't block transact for more than
    ///     72 h per 30 days.
    function invariant_I9_guardianBounded() public view {
        assertFalse(handler.guardianReducedBalance(), "guardian moved funds");
        assertFalse(handler.pauseTooOften(), "spend pause chained within 30 days");
        assertLe(hub.spendsPausedUntil(), block.timestamp + 72 hours);
        if (hub.spendsPausedUntil() > block.timestamp) {
            assertEq(hub.spendsPausedUntil(), hub.lastEmergencyPause() + 72 hours);
        }
    }

    /// I11: nextIndex is even; root history matches the reference implementation.
    function invariant_I11_tree() public view {
        uint32 next = hub.nextLeafIndex();
        assertEq(next % 2, 0, "nextIndex odd");
        assertEq(uint256(next), ref.count(), "leaf count");
        assertEq(hub.getLastRoot(), ref.root(), "root mismatch");
        uint256 rc = ref.rootCount();
        uint256 window = rc < ROOT_HISTORY ? rc : ROOT_HISTORY;
        for (uint256 k; k < window; ++k) {
            assertTrue(hub.isKnownRoot(ref.roots(rc - 1 - k)), "recent root unknown");
        }
        if (rc > ROOT_HISTORY) assertFalse(hub.isKnownRoot(ref.roots(rc - 1 - ROOT_HISTORY)), "stale root known");
        assertFalse(hub.isKnownRoot(0));
    }

    /// @dev Smoke test: every handler path is reachable and the success paths really succeed.
    function test_handlerSmoke() public {
        handler.depositEth(5_000e6, true);
        handler.depositL2(0, 3_000e6, 1e5);
        handler.depositL2(1, 500e6, 0);
        handler.addLiquidity(0, 1_000e6);
        for (uint256 i = 1; i <= 12; ++i) {
            handler.transact(i * 3 + 1, i, i * 7e6, i, i);
        }
        handler.rebalance(0, 2, 0); // ETH -> ARB
        handler.completeMint(2);
        handler.resendRelease(0, 0);
        handler.claim(3);
        handler.slash(10e6);
        handler.takeRewardPot();
        handler.removeLiquidity(0, 50);
        handler.guardianAct(2, 0, 0);
        handler.warp(5 days);
        assertGt(handler.calls("transact.ok"), 5);
        assertGt(handler.calls("rebalance.ok"), 0);
        assertGt(handler.calls("removeLiquidity.ok"), 0);
        assertGt(hub.releaseCount(BASE) + hub.releaseCount(ARB), 0);
        invariant_I1_noDoubleSpend();
        invariant_I2_shieldedSupply();
        invariant_I3_lmSolvency();
        invariant_I7_releases();
        invariant_I9_guardianBounded();
        invariant_I11_tree();
    }

    function invariant_callSummary() public view {
        // keeps the campaign honest: spends must actually succeed
        if (handler.calls("transact") > 20 && handler.pauses() == 0) {
            assertGt(handler.calls("transact.ok"), 0, "no spend ever succeeded");
        }
    }
}
