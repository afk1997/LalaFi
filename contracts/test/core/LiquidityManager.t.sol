// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoreBase} from "./utils/CoreBase.sol";
import {LiquidityManager} from "../../src/hub/LiquidityManager.sol";
import {ILiquidityManager} from "../../src/interfaces/ILiquidityManager.sol";
import {LiquidityManagerConfig} from "../../src/libraries/DeployConfig.sol";
import {MSG_REBALANCE, RebalanceOrder, BridgeParams} from "../../src/libraries/Types.sol";

contract LiquidityManagerTest is CoreBase {
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal attacker = makeAddr("attacker");
    address internal hunter = makeAddr("hunter");

    // ================================================================== constructor / metadata

    function test_metadata() public view {
        assertEq(lm.name(), "xpool LP");
        assertEq(lm.symbol(), "xLP");
        assertEq(lm.decimals(), 6);
        assertEq(lm.targetBps(ETH), 3000);
        assertEq(lm.targetBps(BASE), 3500);
        assertEq(lm.targetBps(ARB), 3500);
        assertEq(address(lm.hub()), address(hub));
    }

    function test_constructor_rejectsBadConfig() public {
        LiquidityManagerConfig memory c = _lmConfig(address(hub));
        c.usdc = address(0);
        vm.expectRevert(LiquidityManager.BadConfig.selector);
        new LiquidityManager(c);

        c = _lmConfig(address(hub));
        c.alphaInsBps = 1001;
        vm.expectRevert(LiquidityManager.BadConfig.selector);
        new LiquidityManager(c);

        c = _lmConfig(address(hub));
        c.targetEthBps = 3001;
        vm.expectRevert(ILiquidityManager.OutOfBounds.selector);
        new LiquidityManager(c);

        c = _lmConfig(address(hub));
        c.targetBpsMin = 7000;
        vm.expectRevert(LiquidityManager.BadConfig.selector);
        new LiquidityManager(c);

        c = _lmConfig(address(hub));
        c.baseDomain = c.arbDomain;
        vm.expectRevert(LiquidityManager.BadConfig.selector);
        new LiquidityManager(c);

        c = _lmConfig(address(hub));
        c.arbChainId = uint64(block.chainid);
        vm.expectRevert(LiquidityManager.BadConfig.selector);
        new LiquidityManager(c);

        c = _lmConfig(address(hub));
        c.minRebalance = 0;
        vm.expectRevert(LiquidityManager.BadConfig.selector);
        new LiquidityManager(c);
    }

    // ================================================================== access control

    function test_restrictedCallers() public {
        vm.startPrank(alice);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.reserve(ETH, 1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.payOnL1(alice, 1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.payRelayer(alice, 1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.accrueProtocolFee(1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.credit(ETH, 1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.creditBounty(alice, 1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.receiveSlashed(1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.takeRewardPot();
        vm.stopPrank();

        // the right contract, wrong function
        vm.startPrank(address(dm));
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.reserve(ETH, 1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.receiveSlashed(1);
        vm.stopPrank();
        vm.startPrank(address(hub));
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.credit(ETH, 1);
        vm.stopPrank();
    }

    // ================================================================== ledger

    function test_credit_and_reserve() public {
        vm.expectEmit(true, false, false, true, address(lm));
        emit ILiquidityManager.Credited(BASE, 100);
        dm.credit(BASE, 100);
        assertEq(lm.available(BASE), 100);

        vm.prank(address(hub));
        vm.expectEmit(true, false, false, true, address(lm));
        emit ILiquidityManager.Reserved(BASE, 60);
        lm.reserve(BASE, 60);
        assertEq(lm.available(BASE), 40);

        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InsufficientLiquidity.selector, BASE));
        lm.reserve(BASE, 41);

        vm.prank(address(hub));
        lm.reserve(BASE, 40); // exactly all
        assertEq(lm.available(BASE), 0);
    }

    function test_credit_reserve_unsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnsupportedChain.selector, uint64(9)));
        dm.credit(9, 1);
        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnsupportedChain.selector, uint64(9)));
        lm.reserve(9, 0);
    }

    function test_payOnL1() public {
        usdc.mint(address(lm), 10);
        vm.prank(address(hub));
        vm.expectEmit(true, false, false, true, address(lm));
        emit ILiquidityManager.PaidOnL1(alice, 10);
        lm.payOnL1(alice, 10);
        assertEq(usdc.balanceOf(alice), 10);

        vm.prank(address(hub));
        vm.expectRevert(LiquidityManager.ZeroAddress.selector);
        lm.payOnL1(address(0), 1);
    }

    function test_payRelayer_paysWhenLiquid() public {
        _depositEth(100);
        vm.prank(address(hub));
        vm.expectEmit(true, false, false, true, address(lm));
        emit ILiquidityManager.RelayerPaid(relayer, 40, false);
        lm.payRelayer(relayer, 40);
        assertEq(usdc.balanceOf(relayer), 40);
        assertEq(lm.available(ETH), 60);
        assertEq(lm.claimable(relayer), 0);
    }

    function test_payRelayer_claimableWhenShort() public {
        _depositEth(30);
        vm.prank(address(hub));
        vm.expectEmit(true, false, false, true, address(lm));
        emit ILiquidityManager.RelayerPaid(relayer, 40, true);
        lm.payRelayer(relayer, 40);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(lm.available(ETH), 30);
        assertEq(lm.claimable(relayer), 40);
        assertEq(lm.totalClaimable(), 40);
    }

    function test_payRelayer_claimableWhenBlacklisted() public {
        _depositEth(100);
        usdc.setBlacklisted(relayer, true);
        vm.prank(address(hub));
        lm.payRelayer(relayer, 40);
        assertEq(lm.claimable(relayer), 40);
        assertEq(lm.available(ETH), 100); // restored
        assertEq(usdc.balanceOf(address(lm)), 100);
    }

    function test_payRelayer_zero() public {
        vm.startPrank(address(hub));
        lm.payRelayer(relayer, 0);
        vm.expectRevert(LiquidityManager.ZeroAddress.selector);
        lm.payRelayer(address(0), 1);
        vm.stopPrank();
    }

    function test_accrueProtocolFee_split() public {
        vm.prank(address(hub));
        vm.expectEmit(false, false, false, true, address(lm));
        emit ILiquidityManager.ProtocolFeeAccrued(1001, 300, 601, 100);
        lm.accrueProtocolFee(1001);
        assertEq(lm.rewardPot(), 300);
        assertEq(lm.insurance(), 100);
        assertEq(lm.lpAssets(), 601); // dust to LPs
        vm.prank(address(hub));
        lm.accrueProtocolFee(0);
        assertEq(lm.rewardPot(), 300);
    }

    function testFuzz_accrueProtocolFee_conserves(uint128 a) public {
        vm.prank(address(hub));
        lm.accrueProtocolFee(a);
        assertEq(lm.rewardPot() + lm.insurance() + lm.lpAssets(), a);
    }

    function test_creditBounty_and_claim() public {
        dm.creditBounty(hunter, 75);
        assertEq(lm.claimable(hunter), 75);
        assertEq(lm.totalClaimable(), 75);

        // nothing on ETH yet: claim fails
        vm.prank(hunter);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InsufficientLiquidity.selector, ETH));
        lm.claim();

        // partial
        _depositEth(50);
        vm.prank(hunter);
        vm.expectEmit(true, false, false, true, address(lm));
        emit ILiquidityManager.Claimed(hunter, 50);
        lm.claim();
        assertEq(usdc.balanceOf(hunter), 50);
        assertEq(lm.claimable(hunter), 25);
        assertEq(lm.available(ETH), 0);

        // rest
        _depositEth(100);
        vm.prank(hunter);
        lm.claim();
        assertEq(usdc.balanceOf(hunter), 75);
        assertEq(lm.claimable(hunter), 0);
        assertEq(lm.totalClaimable(), 0);
        assertEq(lm.available(ETH), 75);

        vm.prank(hunter);
        vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
        lm.claim();
    }

    function test_creditBounty_zeroAddress() public {
        vm.expectRevert(LiquidityManager.ZeroAddress.selector);
        dm.creditBounty(address(0), 1);
    }

    function test_receiveSlashed() public {
        vm.expectEmit(false, false, false, true, address(lm));
        emit ILiquidityManager.SlashedReceived(500);
        sm.slashIn(500);
        assertEq(lm.insurance(), 500);
        assertEq(lm.available(ETH), 500);
        assertEq(usdc.balanceOf(address(lm)), 500);
    }

    function test_takeRewardPot_fullAndPartial() public {
        vm.prank(address(hub));
        lm.accrueProtocolFee(10_000); // pot 3000
        _depositEth(2_000);
        vm.expectEmit(false, false, false, true, address(lm));
        emit ILiquidityManager.RewardPotTaken(2_000);
        assertEq(sm.take(), 2_000);
        assertEq(lm.rewardPot(), 1_000);
        assertEq(lm.available(ETH), 0);
        assertEq(usdc.balanceOf(address(sm)), 2_000);

        _depositEth(5_000);
        assertEq(sm.take(), 1_000);
        assertEq(lm.rewardPot(), 0);
        assertEq(lm.available(ETH), 4_000);
        assertEq(sm.take(), 0);
    }

    // ================================================================== LPs

    function test_addRemoveLiquidity() public {
        uint256 shares = _addLp(lp1, 1_000e6);
        assertEq(shares, 1_000e6 * 1e6); // 10^6 virtual offset
        assertEq(lm.balanceOf(lp1), shares);
        assertEq(lm.lpAssets(), 1_000e6);
        assertEq(lm.available(ETH), 1_000e6);

        vm.prank(lp1);
        vm.expectEmit(true, true, false, true, address(lm));
        emit ILiquidityManager.LiquidityRemoved(lp1, alice, 400e6, shares * 2 / 5);
        uint256 out = lm.removeLiquidity(shares * 2 / 5, alice);
        assertEq(out, 400e6);
        assertEq(usdc.balanceOf(alice), 400e6);
        assertEq(lm.lpAssets(), 600e6);
        assertEq(lm.available(ETH), 600e6);
    }

    function test_lpEarnsAlphaLp() public {
        uint256 shares = _addLp(lp1, 1_000e6);
        vm.prank(address(hub));
        lm.accrueProtocolFee(100e6); // 60e6 to LPs
        assertApproxEqAbs(lm.previewRemove(shares), 1_060e6, 1);
    }

    function test_addLiquidity_reverts() public {
        vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
        lm.addLiquidity(0, lp1);
        vm.expectRevert(LiquidityManager.ZeroAddress.selector);
        lm.addLiquidity(1, address(0));
        vm.prank(guardian);
        hub.setInflowsPaused(true);
        vm.expectRevert(ILiquidityManager.InflowsPaused.selector);
        lm.addLiquidity(1, lp1);
    }

    function test_removeLiquidity_notBlockedByInflowPause() public {
        uint256 shares = _addLp(lp1, 100e6);
        vm.prank(guardian);
        hub.setInflowsPaused(true);
        vm.prank(lp1);
        lm.removeLiquidity(shares, lp1);
        assertEq(usdc.balanceOf(lp1), 100e6);
    }

    function test_removeLiquidity_reverts() public {
        uint256 shares = _addLp(lp1, 100e6);
        vm.startPrank(lp1);
        vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
        lm.removeLiquidity(0, lp1);
        vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
        lm.removeLiquidity(1, lp1); // rounds to 0 assets
        vm.expectRevert(LiquidityManager.ZeroAddress.selector);
        lm.removeLiquidity(shares, address(0));
        vm.expectRevert(); // ERC20InsufficientBalance
        lm.removeLiquidity(shares + 1e6, lp1);
        vm.stopPrank();
    }

    function test_removeLiquidity_needsLEth() public {
        uint256 shares = _addLp(lp1, 100e6);
        // A withdrawal reserves most of L[ETH] (here: direct reserve by the hub).
        vm.prank(address(hub));
        lm.reserve(ETH, 60e6);
        vm.prank(lp1);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InsufficientLiquidity.selector, ETH));
        lm.removeLiquidity(shares, lp1);
        vm.prank(lp1);
        lm.removeLiquidity(shares * 2 / 5, lp1); // 40e6 fits
    }

    function test_safetyValve() public {
        uint256 shares = _addLp(lp1, 1_000e6);
        sm.slashIn(100e6); // insurance 100
        dm.setBeta(1, 2);
        // ufv = 300: remove x allowed iff 300 <= (1000 - x + 100) / 2  <=> x <= 500
        dm.setUnconfirmedFastValue(300e6);
        uint256 tooMany = lm.previewAdd(500e6 + 1);
        vm.startPrank(lp1);
        vm.expectRevert(ILiquidityManager.SafetyValve.selector);
        lm.removeLiquidity(tooMany, lp1);
        lm.removeLiquidity(shares / 2, lp1); // exactly 500e6
        vm.expectRevert(ILiquidityManager.SafetyValve.selector);
        lm.removeLiquidity(1e6, lp1);
        vm.stopPrank();
        // once confirmed, LPs can leave
        dm.setUnconfirmedFastValue(0);
        uint256 rest = lm.balanceOf(lp1);
        vm.prank(lp1);
        lm.removeLiquidity(rest, lp1);
        assertEq(lm.lpAssets(), 0);
    }

    function test_safetyValve_failsClosedWithoutBeta() public {
        uint256 shares = _addLp(lp1, 1_000e6);
        dm.setBetaMissing(true);
        dm.setUnconfirmedFastValue(1);
        vm.prank(lp1);
        vm.expectRevert(ILiquidityManager.SafetyValve.selector);
        lm.removeLiquidity(shares, lp1);
        dm.setBetaMissing(false);
        dm.setBeta(1, 0);
        vm.prank(lp1);
        vm.expectRevert(ILiquidityManager.SafetyValve.selector);
        lm.removeLiquidity(shares, lp1);
        // zero unconfirmed value never needs beta
        dm.setBetaMissing(true);
        dm.setUnconfirmedFastValue(0);
        vm.prank(lp1);
        lm.removeLiquidity(shares, lp1);
    }

    /// @dev First-depositor inflation attack: donations can't move the price (lpAssets is pure
    ///      accounting), and fee-based inflation is bounded by the 10^6 virtual offset.
    function test_inflationAttack_donation() public {
        uint256 aShares = _addLp(attacker, 1);
        usdc.mint(address(lm), 1_000_000e6); // direct donation
        uint256 vShares = _addLp(lp2, 1_000e6);
        assertEq(vShares, 1_000e6 * (aShares + 1e6) / 2);
        vm.prank(lp2);
        uint256 back = lm.removeLiquidity(vShares, lp2);
        assertApproxEqAbs(back, 1_000e6, 1);
        vm.prank(attacker);
        uint256 aBack = lm.removeLiquidity(aShares, attacker);
        assertLe(aBack, 1);
    }

    function test_inflationAttack_feeInflation() public {
        uint256 aShares = _addLp(attacker, 1);
        // Attacker routes a huge fee into lpAssets (paid out of their own shielded value).
        vm.prank(address(hub));
        lm.accrueProtocolFee(10_000e6); // +6000e6 to lpAssets
        uint256 victim = 1_000e6;
        uint256 vShares = _addLp(lp2, victim);
        assertGt(vShares, 0);
        uint256 vValue = lm.previewRemove(vShares);
        // victim loses at most a tiny fraction (bounded by assets / 10^6 offset)
        assertGe(vValue, victim - victim / 1e5);
        // and the attacker can't extract more than (deposit + almost all fees)
        uint256 aValue = lm.previewRemove(aShares);
        assertLe(aValue, 1 + 6_000e6);
    }

    function testFuzz_addRemove_noProfit(uint96 first, uint96 fee, uint96 a2) public {
        uint256 y = bound(a2, 1, 1e15);
        _addLp(lp1, bound(first, 1, 1e15));
        vm.prank(address(hub));
        lm.accrueProtocolFee(bound(fee, 0, 1e15));
        if (lm.previewAdd(y) == 0) {
            // never mints zero shares for a positive deposit
            usdc.mint(lp2, y);
            vm.startPrank(lp2);
            usdc.approve(address(lm), y);
            vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
            lm.addLiquidity(y, lp2);
            vm.stopPrank();
            return;
        }
        uint256 s = _addLp(lp2, y);
        if (lm.previewRemove(s) == 0) return;
        vm.prank(lp2);
        uint256 back = lm.removeLiquidity(s, lp2);
        assertLe(back, y);
    }

    // ================================================================== rebalance (PRD 11.3)

    /// @dev L = ETH 6000, BASE 2000, ARB 2000 (total 10000); targets 3000 / 3500 / 3500.
    function _skewed() internal {
        _depositEth(6_000e6);
        _depositL2(BASE, 2_000e6);
        _depositL2(ARB, 2_000e6);
    }

    function test_rebalance_ethToBase() public {
        _skewed();
        vm.expectEmit(true, true, false, true, address(lm));
        emit ILiquidityManager.Rebalanced(ETH, BASE, 1_500e6, 0, 1);
        lm.rebalance(ETH, BASE, 1_500e6, _bp());
        assertEq(lm.available(ETH), 4_500e6);
        assertEq(lm.available(BASE), 3_500e6);
        assertEq(lm.rebalanceNonce(), 1);
        (
            uint256 amount,
            uint32 domain,
            bytes32 mintRecipient,
            address token,
            bytes32 caller,
            uint256 maxFee,
            uint32 fin
        ) = tm.burns(0);
        assertEq(amount, 1_500e6);
        assertEq(domain, 6);
        assertEq(mintRecipient, bytes32(uint256(uint160(baseSpoke))));
        assertEq(token, address(usdc));
        assertEq(caller, bytes32(0));
        assertEq(maxFee, 0);
        assertEq(fin, 2000);
        assertEq(usdc.balanceOf(address(tm)), 1_500e6);
        assertEq(usdc.allowance(address(lm), address(tm)), 0);
    }

    function test_rebalance_ethSrcRejectsValue() public {
        _skewed();
        vm.deal(address(this), 1 ether);
        vm.expectRevert(LiquidityManager.UnexpectedValue.selector);
        lm.rebalance{value: 1}(ETH, BASE, 100e6, _bp());
    }

    function test_rebalance_l2ToEth() public {
        _depositEth(1_000e6);
        _depositL2(BASE, 6_000e6);
        _depositL2(ARB, 3_000e6);
        // targets: ETH 3000, BASE 3500; ETH deficit 2000, BASE surplus 2500
        lm.rebalance(BASE, ETH, 2_000e6, _bp());
        assertEq(lm.available(BASE), 4_000e6);
        assertEq(lm.available(ETH), 3_000e6);
        (uint8 kind, bytes memory body) = baseAdapter.lastMessage();
        assertEq(kind, MSG_REBALANCE);
        RebalanceOrder memory o = abi.decode(body, (RebalanceOrder));
        assertEq(o.amount, 2_000e6);
        assertEq(o.dstDomain, 0);
        assertEq(o.mintRecipient, bytes32(uint256(uint160(address(lm)))));
        assertEq(o.maxFee, 0);
        assertEq(o.minFinality, 2000);
        assertEq(o.nonce, 1);
    }

    function test_rebalance_arbToBase_forwardsValue() public {
        _depositEth(3_000e6);
        _depositL2(BASE, 1_000e6);
        _depositL2(ARB, 6_000e6);
        arbAdapter.setMinValue(1 gwei);
        vm.deal(address(this), 1 ether);
        lm.rebalance{value: 3 gwei}(ARB, BASE, 2_500e6, _bp());
        assertEq(arbAdapter.lastValue(), 3 gwei);
        (, bytes memory body) = arbAdapter.lastMessage();
        RebalanceOrder memory o = abi.decode(body, (RebalanceOrder));
        assertEq(o.dstDomain, 6);
        assertEq(o.mintRecipient, bytes32(uint256(uint160(baseSpoke))));
        assertEq(lm.available(BASE), 3_500e6);
        assertEq(lm.available(ARB), 3_500e6);
    }

    function test_rebalance_policyEdges() public {
        _skewed();
        // m < minRebalance
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(ETH, BASE, MIN_REBALANCE - 1, _bp());
        // m > target[dst] - L[dst] (deficit 1500)
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(ETH, BASE, 1_500e6 + 1, _bp());
        // src without surplus (BASE is in deficit)
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(BASE, ARB, MIN_REBALANCE, _bp());
        // dst not in deficit (ETH)
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(BASE, ETH, MIN_REBALANCE, _bp());
        // src == dst
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(ETH, ETH, MIN_REBALANCE, _bp());
        // unsupported / zero
        vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnsupportedChain.selector, uint64(7)));
        lm.rebalance(7, BASE, MIN_REBALANCE, _bp());
        vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnsupportedChain.selector, uint64(7)));
        lm.rebalance(ETH, 7, MIN_REBALANCE, _bp());
        vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
        lm.rebalance(ETH, BASE, 0, _bp());

        // Exactly the deficit is allowed, then dst is no longer in deficit.
        lm.rebalance(ETH, BASE, 1_500e6, _bp());
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(ETH, BASE, MIN_REBALANCE, _bp());
        // ETH 4500 -> ARB: surplus is 1500 = deficit; L[src] - m == target[src] is allowed
        lm.rebalance(ETH, ARB, 1_500e6, _bp());
        assertEq(lm.available(ETH), 3_000e6);
        assertEq(lm.target(ETH), 3_000e6);
    }

    function test_rebalance_sourceSurplusBoundary() public {
        // ETH 3100, BASE 3500, ARB 3400 (total 10000): ETH surplus 100, ARB deficit 100.
        _depositEth(3_100e6);
        _depositL2(BASE, 3_500e6);
        _depositL2(ARB, 3_400e6);
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(ETH, ARB, 100e6 + 1, _bp()); // would leave ETH below target
        lm.rebalance(ETH, ARB, 100e6, _bp());
    }

    function test_rebalance_insufficientSource() public {
        _depositEth(100e6);
        _depositL2(BASE, 0);
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(BASE, ETH, MIN_REBALANCE, _bp());
    }

    // ================================================================== guardian targets

    function test_setTargets() public {
        vm.prank(guardian);
        vm.expectEmit(false, false, false, true, address(lm));
        emit ILiquidityManager.TargetsUpdated(2000, 4000, 4000);
        lm.setTargets(2000, 4000, 4000);
        assertEq(lm.targetBps(ETH), 2000);
        assertEq(lm.targetBps(BASE), 4000);
        assertEq(lm.targetBps(ARB), 4000);
    }

    function test_setTargets_bounds() public {
        vm.startPrank(guardian);
        vm.expectRevert(ILiquidityManager.OutOfBounds.selector);
        lm.setTargets(999, 4501, 4500); // below min
        vm.expectRevert(ILiquidityManager.OutOfBounds.selector);
        lm.setTargets(6001, 2000, 1999); // above max
        vm.expectRevert(ILiquidityManager.OutOfBounds.selector);
        lm.setTargets(3000, 3500, 3499); // sum != 10000
        lm.setTargets(1000, 3000, 6000); // boundaries ok
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(ILiquidityManager.OnlyGuardian.selector);
        lm.setTargets(3000, 3500, 3500);
    }
}
