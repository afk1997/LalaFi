// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

import {HubCore} from "../../../src/hub/HubCore.sol";
import {LiquidityManager} from "../../../src/hub/LiquidityManager.sol";
import {MockUSDC} from "../../../src/mocks/MockUSDC.sol";
import {MockVerifier} from "../../../src/mocks/MockVerifier.sol";
import {HubCoreConfig, LiquidityManagerConfig} from "../../../src/libraries/DeployConfig.sol";
import {P, Proof, PublicInputs, ExtData, BridgeParams, EXT_DATA_VERSION} from "../../../src/libraries/Types.sol";
import {
    CoreMockDepositManager,
    CoreMockStakeManager,
    CoreMockAdapter,
    CoreMockTokenMessenger
} from "../mocks/CoreMocks.sol";

/// @notice Shared fixture: real HubCore + LiquidityManager + PoseidonT3, mock everything else.
abstract contract CoreBase is Test {
    uint64 internal constant BASE = 84532;
    uint64 internal constant ARB = 421614;
    uint64 internal ETH;

    uint256 internal constant PHI_BPS = 10;
    uint256 internal constant BUCKET = 10_000; // 0.01 USDC
    uint256 internal constant MIN_W = 1e6;
    uint256 internal constant MIN_REBALANCE = 50e6;

    address internal poseidon;
    MockVerifier internal verifier;
    MockUSDC internal usdc;
    CoreMockDepositManager internal dm;
    CoreMockStakeManager internal sm;
    CoreMockAdapter internal baseAdapter;
    CoreMockAdapter internal arbAdapter;
    CoreMockTokenMessenger internal tm;
    HubCore internal hub;
    LiquidityManager internal lm;

    address internal guardian = makeAddr("guardian");
    address internal baseSpoke = makeAddr("baseSpoke");
    address internal arbSpoke = makeAddr("arbSpoke");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");

    uint256 internal _nullifierNonce = 1;
    uint256 internal _commitNonce = 1;

    function setUp() public virtual {
        ETH = uint64(block.chainid);
        vm.warp(1_700_000_000);
        poseidon = deployCode("PoseidonT3.sol:PoseidonT3");
        verifier = new MockVerifier();
        usdc = new MockUSDC();
        dm = new CoreMockDepositManager();
        sm = new CoreMockStakeManager();
        baseAdapter = new CoreMockAdapter(false);
        arbAdapter = new CoreMockAdapter(true);
        tm = new CoreMockTokenMessenger();

        address predictedHub = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        lm = new LiquidityManager(_lmConfig(predictedHub));
        hub = new HubCore(_hubConfig());
        assertEq(address(hub), predictedHub);

        dm.wire(address(hub), address(lm));
        sm.wire(address(lm), address(usdc));
        baseAdapter.allow(address(hub));
        baseAdapter.allow(address(lm));
        arbAdapter.allow(address(hub));
        arbAdapter.allow(address(lm));
    }

    function _hubConfig() internal view returns (HubCoreConfig memory c) {
        c = HubCoreConfig({
            verifier: address(verifier),
            poseidonT3: poseidon,
            depositManager: address(dm),
            liquidityManager: address(lm),
            guardian: guardian,
            baseChainId: BASE,
            baseAdapter: address(baseAdapter),
            arbChainId: ARB,
            arbAdapter: address(arbAdapter),
            phiBps: PHI_BPS,
            relayerFeeBucket: BUCKET,
            minWithdrawEth: MIN_W,
            minWithdrawBase: MIN_W,
            minWithdrawArb: MIN_W
        });
    }

    function _lmConfig(address hub_) internal view returns (LiquidityManagerConfig memory c) {
        c = LiquidityManagerConfig({
            usdc: address(usdc),
            hub: hub_,
            depositManager: address(dm),
            stakeManager: address(sm),
            tokenMessengerV2: address(tm),
            ethDomain: 0,
            baseChainId: BASE,
            baseAdapter: address(baseAdapter),
            baseSpoke: baseSpoke,
            baseDomain: 6,
            arbChainId: ARB,
            arbAdapter: address(arbAdapter),
            arbSpoke: arbSpoke,
            arbDomain: 3,
            alphaVBps: 3000,
            alphaLPBps: 6000,
            alphaInsBps: 1000,
            targetEthBps: 3000,
            targetBaseBps: 3500,
            targetArbBps: 3500,
            targetBpsMin: 1000,
            targetBpsMax: 6000,
            minRebalance: MIN_REBALANCE
        });
    }

    // ------------------------------------------------------------------ deposit helpers

    function _freshCommitment() internal returns (uint256) {
        return uint256(keccak256(abi.encode("c", _commitNonce++))) % P;
    }

    function _freshNullifier() internal returns (uint256) {
        return uint256(keccak256(abi.encode("n", _nullifierNonce++))) % P;
    }

    /// @dev Ethereum deposit through the mock DM: leaf + shieldedSupply + L[ETH] + USDC in the vault.
    function _depositEth(uint256 amount) internal returns (uint32 leafIndex) {
        uint256[] memory cs = new uint256[](1);
        cs[0] = _freshCommitment();
        usdc.mint(address(lm), amount);
        leafIndex = dm.insert(cs, amount);
        dm.credit(ETH, amount);
    }

    /// @dev Canonically confirmed L2 deposit: leaf + shieldedSupply + L[c] (+ fee as bounty).
    function _depositL2(uint64 chainId, uint256 amount) internal returns (uint32 leafIndex) {
        uint256[] memory cs = new uint256[](1);
        cs[0] = _freshCommitment();
        leafIndex = dm.insert(cs, amount);
        dm.credit(chainId, amount);
    }

    function _addLp(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(lm), amount);
        shares = lm.addLiquidity(amount, who);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ spend helpers

    function _protocolFee(uint256 w) internal pure returns (uint256) {
        return (w * PHI_BPS + 9_999) / 10_000;
    }

    function _ext(uint64 dst, address recipient, uint256 w, uint256 relayerFee)
        internal
        view
        returns (ExtData memory e)
    {
        e = ExtData({
            version: EXT_DATA_VERSION,
            hubChainId: uint64(block.chainid),
            hub: address(hub),
            dstChainId: dst,
            recipient: recipient,
            withdrawAmount: w,
            relayer: relayer,
            relayerFee: relayerFee,
            protocolFee: dst == 0 ? 0 : _protocolFee(w),
            deadline: uint64(block.timestamp + 1 hours),
            encOut0: hex"aa",
            encOut1: hex"bb"
        });
    }

    function _extHash(ExtData memory e) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(e))) % P;
    }

    function _pi(ExtData memory e) internal returns (PublicInputs memory pi) {
        uint256 v = e.withdrawAmount + e.relayerFee + e.protocolFee;
        pi.root = hub.getLastRoot();
        pi.publicAmount = v == 0 ? 0 : P - v;
        pi.extDataHash = _extHash(e);
        pi.inputNullifiers = [_freshNullifier(), _freshNullifier()];
        pi.outputCommitments = [_freshCommitment(), _freshCommitment()];
    }

    function _proof() internal pure returns (Proof memory pr) {}

    function _bp() internal pure returns (BridgeParams memory b) {}

    function _transact(ExtData memory e) internal returns (PublicInputs memory pi) {
        pi = _pi(e);
        hub.transact(_proof(), pi, e, _bp());
    }

    function _transactValue(ExtData memory e, uint256 value) internal returns (PublicInputs memory pi) {
        pi = _pi(e);
        hub.transact{value: value}(_proof(), pi, e, _bp());
    }
}
