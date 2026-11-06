// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

import {HubCore} from "../../src/hub/HubCore.sol";
import {LiquidityManager} from "../../src/hub/LiquidityManager.sol";
import {IHubCore} from "../../src/interfaces/IHubCore.sol";
import {ILiquidityManager} from "../../src/interfaces/ILiquidityManager.sol";
import {IDepositManager} from "../../src/interfaces/IDepositManager.sol";
import {IStakeManager} from "../../src/interfaces/IStakeManager.sol";
import {MockVerifier} from "../../src/mocks/MockVerifier.sol";
import {HubCoreConfig, LiquidityManagerConfig, DepositManagerConfig, StakeManagerConfig} from "../../src/libraries/DeployConfig.sol";
import {L2Deposit, BridgeParams} from "../../src/libraries/Types.sol";
import {FastlaneBase} from "../fastlane/FastlaneBase.sol";

/// 18-decimal stand-in for a test DAI.
contract TestDai is ERC20 {
    constructor() ERC20("Dai Stablecoin", "DAI") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// A pool deployed on Ethereum + Base only (arbChainId == 0) with no CCTP (e.g. the DAI pool).
contract TwoChainHubTest is Test {
    uint64 internal constant BASE = 84532;
    uint64 internal constant ARB = 421614;

    HubCore internal hub;
    LiquidityManager internal lm;
    TestDai internal dai;
    address internal baseAdapter = makeAddr("baseAdapter");
    address internal baseSpoke = makeAddr("baseSpoke");

    address internal verifier;
    address internal poseidon;

    function _hubCfg(address lm_) internal returns (HubCoreConfig memory c) {
        c = HubCoreConfig({
            verifier: verifier,
            poseidonT3: poseidon,
            depositManager: makeAddr("dm"),
            liquidityManager: lm_,
            guardian: makeAddr("guardian"),
            baseChainId: BASE,
            baseAdapter: baseAdapter,
            arbChainId: 0,
            arbAdapter: address(0),
            phiBps: 10,
            relayerFeeBucket: 1e16,
            minWithdrawEth: 1e18,
            minWithdrawBase: 1e18,
            minWithdrawArb: 0
        });
    }

    function _lmCfg(address hub_) internal returns (LiquidityManagerConfig memory c) {
        c = LiquidityManagerConfig({
            usdc: address(dai),
            hub: hub_,
            depositManager: makeAddr("dm"),
            stakeManager: makeAddr("sm"),
            tokenMessengerV2: address(0),
            ethDomain: 0,
            baseChainId: BASE,
            baseAdapter: baseAdapter,
            baseSpoke: baseSpoke,
            baseDomain: 0,
            arbChainId: 0,
            arbAdapter: address(0),
            arbSpoke: address(0),
            arbDomain: 0,
            alphaVBps: 3000,
            alphaLPBps: 6000,
            alphaInsBps: 1000,
            targetEthBps: 5000,
            targetBaseBps: 5000,
            targetArbBps: 0,
            targetBpsMin: 1000,
            targetBpsMax: 9000,
            minRebalance: 5e18
        });
    }

    function setUp() public {
        dai = new TestDai();
        verifier = address(new MockVerifier());
        poseidon = deployCode("PoseidonT3.sol:PoseidonT3");
        address predictedHub = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        lm = new LiquidityManager(_lmCfg(predictedHub));
        hub = new HubCore(_hubCfg(address(lm)));
        assertEq(address(hub), predictedHub);
    }

    function test_chainSupport() public view {
        assertTrue(hub.isSupportedChain(uint64(block.chainid)));
        assertTrue(hub.isSupportedChain(BASE));
        assertFalse(hub.isSupportedChain(ARB));
        assertFalse(hub.isSupportedChain(0)); // must never alias the disabled slot
        assertEq(hub.adapterFor(BASE), baseAdapter);
    }

    function test_disabledChainReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, uint64(0)));
        hub.minWithdraw(0);
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, ARB));
        hub.minWithdraw(ARB);
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, uint64(0)));
        hub.adapterFor(0);
    }

    function test_lpSharesUseTokenDecimals() public view {
        assertEq(lm.decimals(), 18);
    }

    function test_noCctpMeansNoRebalance() public {
        BridgeParams memory bp;
        vm.expectRevert(ILiquidityManager.RebalancePolicy.selector);
        lm.rebalance(uint64(block.chainid), BASE, 10e18, bp);
    }

    function test_targetsMustLeaveArbAtZero() public {
        vm.prank(makeAddr("guardian"));
        // guardian() is read from the hub; arb target must stay 0 when Arbitrum is disabled
        vm.expectRevert(ILiquidityManager.OutOfBounds.selector);
        lm.setTargets(4000, 4000, 2000);
    }

    function test_rejectsHalfConfiguredArbitrum() public {
        HubCoreConfig memory c = _hubCfg(address(lm));
        c.arbAdapter = makeAddr("x"); // chain id 0 but an adapter set
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        LiquidityManagerConfig memory l = _lmCfg(address(hub));
        l.targetEthBps = 4000;
        l.targetBaseBps = 4000;
        l.targetArbBps = 2000; // target for a disabled chain
        vm.expectRevert(LiquidityManager.BadConfig.selector);
        new LiquidityManager(l);
    }
}

/// DepositManager + StakeManager with Arbitrum disabled: Base keeps working, Arbitrum and chain 0 are rejected.
contract TwoChainFastlaneTest is FastlaneBase {
    function _smConfig() internal view override returns (StakeManagerConfig memory c) {
        c = super._smConfig();
        c.arbChainId = 0;
    }

    function _dmConfig() internal view override returns (DepositManagerConfig memory c) {
        c = super._dmConfig();
        c.arbChainId = 0;
        c.arbAdapter = address(0);
        c.arbSpoke = address(0);
    }

    function test_spokeLookup() public view {
        assertEq(dm.spokeOf(BASE), baseSpoke);
        assertEq(dm.spokeOf(ARB), address(0));
        assertEq(dm.spokeOf(0), address(0));
    }

    function test_checkpointFromDisabledChainRejected() public {
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.UnsupportedChain.selector, uint64(0)));
        dm.receiveCheckpoint(0, "");
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.UnsupportedChain.selector, ARB));
        dm.receiveCheckpoint(ARB, "");
    }

    function test_allocationToDisabledChainRejected() public {
        address op = makeAddr("op");
        usdc.mint(op, SMIN);
        vm.startPrank(op);
        sm.register(makeAddr("signer"));
        usdc.approve(address(sm), type(uint256).max);
        sm.bond(SMIN);
        uint64[] memory cs = new uint64[](1);
        uint256[] memory as_ = new uint256[](1);
        as_[0] = SMIN;
        cs[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(IStakeManager.UnsupportedChain.selector, uint64(0)));
        sm.setAllocations(cs, as_);
        cs[0] = ARB;
        vm.expectRevert(abi.encodeWithSelector(IStakeManager.UnsupportedChain.selector, ARB));
        sm.setAllocations(cs, as_);
        cs[0] = BASE;
        sm.setAllocations(cs, as_); // Base still works
        vm.stopPrank();
    }

    function test_baseFastLaneStillWorks() public {
        // one validator, all stake on Base
        uint256 pk = 0xB0B;
        address op = makeAddr("op1");
        usdc.mint(op, 10 * SMIN);
        vm.startPrank(op);
        sm.register(vm.addr(pk));
        usdc.approve(address(sm), type(uint256).max);
        sm.bond(10 * SMIN);
        uint64[] memory cs = new uint64[](1);
        uint256[] memory as_ = new uint256[](1);
        cs[0] = BASE;
        as_[0] = 10 * SMIN;
        sm.setAllocations(cs, as_);
        vm.stopPrank();
        pks.push(pk);
        _advance();

        L2Deposit[] memory deps = _spokeDeposits(BASE, 2, 5e6);
        uint256[] memory signer = new uint256[](1);
        signer[0] = pk;
        uint256 id = _attest(BASE, sm.currentEpoch(), deps, signer);
        assertEq(uint256(dm.batchStatus(id)), uint256(IDepositManager.BatchStatus.Pending));
    }
}
