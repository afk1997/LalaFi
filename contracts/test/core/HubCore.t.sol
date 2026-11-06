// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CoreBase} from "./utils/CoreBase.sol";
import {HubCore} from "../../src/hub/HubCore.sol";
import {IHubCore} from "../../src/interfaces/IHubCore.sol";
import {ILiquidityManager} from "../../src/interfaces/ILiquidityManager.sol";
import {HubCoreConfig} from "../../src/libraries/DeployConfig.sol";
import {ZeroHashes} from "../../src/libraries/ZeroHashes.sol";
import {
    P,
    AMOUNT_BOUND,
    MSG_RELEASE,
    MSG_PAUSE,
    PublicInputs,
    ExtData,
    Release,
    BridgeParams
} from "../../src/libraries/Types.sol";
import {ReentrantAdapter} from "./mocks/CoreMocks.sol";

contract HubCoreTest is CoreBase {
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        // Fund: 1,000 USDC on each chain of the ledger, all of it shielded.
        _depositEth(1_000e6);
        _depositL2(BASE, 1_000e6);
        _depositL2(ARB, 1_000e6);
    }

    // ================================================================== constructor

    function test_constructor_rejectsBadConfig() public {
        HubCoreConfig memory c = _hubConfig();
        c.verifier = address(0xdead); // no code
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        c = _hubConfig();
        c.guardian = address(0);
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        c = _hubConfig();
        c.baseChainId = c.arbChainId;
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        c = _hubConfig();
        c.arbChainId = uint64(block.chainid);
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        c = _hubConfig();
        c.relayerFeeBucket = 0;
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        c = _hubConfig();
        c.phiBps = 1_001;
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        c = _hubConfig();
        c.minWithdrawBase = 0;
        vm.expectRevert(HubCore.BadConfig.selector);
        new HubCore(c);

        c = _hubConfig();
        c.poseidonT3 = address(0xbeef);
        vm.expectRevert();
        new HubCore(c);
    }

    function test_initialState() public {
        HubCore fresh = new HubCore(_hubConfig());
        assertEq(fresh.getLastRoot(), ZeroHashes.Z24);
        assertTrue(fresh.isKnownRoot(ZeroHashes.Z24));
        assertFalse(fresh.isKnownRoot(0));
        assertEq(fresh.nextLeafIndex(), 0);
        assertEq(fresh.shieldedSupply(), 0);
        assertEq(fresh.guardian(), guardian);
        assertEq(fresh.phiBps(), PHI_BPS);
        assertEq(fresh.relayerFeeBucket(), BUCKET);
    }

    function test_views() public view {
        assertTrue(hub.isSupportedChain(ETH));
        assertTrue(hub.isSupportedChain(BASE));
        assertTrue(hub.isSupportedChain(ARB));
        assertFalse(hub.isSupportedChain(1234));
        assertFalse(hub.isSupportedChain(0));
        assertEq(hub.adapterFor(ETH), address(0));
        assertEq(hub.adapterFor(BASE), address(baseAdapter));
        assertEq(hub.adapterFor(ARB), address(arbAdapter));
        assertEq(hub.minWithdraw(ETH), MIN_W);
        assertEq(hub.minWithdraw(BASE), MIN_W);
        assertEq(hub.minWithdraw(ARB), MIN_W);
    }

    function test_views_unsupportedRevert() public {
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, uint64(1234)));
        hub.adapterFor(1234);
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, uint64(1234)));
        hub.minWithdraw(1234);
    }

    // ================================================================== insertDepositLeaves

    function test_insertDepositLeaves_onlyDepositManager() public {
        uint256[] memory cs = new uint256[](1);
        cs[0] = 1;
        vm.expectRevert(IHubCore.OnlyDepositManager.selector);
        hub.insertDepositLeaves(cs, 1);
    }

    function test_insertDepositLeaves_oddPadsWithZ0() public {
        uint32 before = hub.nextLeafIndex();
        uint256 supplyBefore = hub.shieldedSupply();
        uint256[] memory cs = new uint256[](3);
        cs[0] = 11;
        cs[1] = 22;
        cs[2] = 33;
        vm.expectEmit(true, false, false, false, address(hub));
        emit IHubCore.LeavesInserted(before, 4, 0);
        uint32 first = dm.insert(cs, 77);
        assertEq(first, before);
        assertEq(hub.nextLeafIndex(), before + 4);
        assertEq(hub.shieldedSupply(), supplyBefore + 77);
        assertEq(hub.nextLeafIndex() % 2, 0);
    }

    function test_insertDepositLeaves_evenCount() public {
        uint32 before = hub.nextLeafIndex();
        uint256[] memory cs = new uint256[](2);
        cs[0] = 5;
        cs[1] = 6;
        dm.insert(cs, 0);
        assertEq(hub.nextLeafIndex(), before + 2);
    }

    function test_insertDepositLeaves_rejectsFieldOverflow() public {
        uint256[] memory cs = new uint256[](2);
        cs[0] = 5;
        cs[1] = P;
        vm.expectRevert(IHubCore.FieldOverflow.selector);
        dm.insert(cs, 0);
    }

    function test_insertDepositLeaves_rejectsEmpty() public {
        uint256[] memory cs = new uint256[](0);
        vm.expectRevert(HubCore.EmptyLeaves.selector);
        dm.insert(cs, 0);
    }

    function test_insertDepositLeaves_treeFull() public {
        // slot 0 packs _nextIndex (uint32, low bits) and _rootSeqCounter (uint64).
        bytes32 slot0 = vm.load(address(hub), bytes32(uint256(0)));
        uint256 seq = uint256(slot0) >> 32;
        vm.store(address(hub), bytes32(uint256(0)), bytes32((seq << 32) | ((1 << 24) - 2)));
        assertEq(hub.nextLeafIndex(), (1 << 24) - 2);
        uint256[] memory cs = new uint256[](1);
        cs[0] = 9;
        dm.insert(cs, 0); // fills the last pair
        assertEq(hub.nextLeafIndex(), 1 << 24);
        vm.expectRevert(IHubCore.TreeFull.selector);
        dm.insert(cs, 0);
    }

    // ================================================================== transact: success paths

    function test_transact_withdrawToEth() public {
        uint256 w = 100e6;
        ExtData memory e = _ext(ETH, bob, w, 20 * BUCKET);
        uint256 fee = _protocolFee(w);
        uint256 supplyBefore = hub.shieldedSupply();
        uint256 lBefore = lm.available(ETH);
        uint32 idx = hub.nextLeafIndex();

        PublicInputs memory pi = _pi(e);
        vm.expectEmit(true, false, false, false, address(hub));
        emit IHubCore.NewNullifier(pi.inputNullifiers[0]);
        vm.expectEmit(true, false, false, false, address(hub));
        emit IHubCore.NewNullifier(pi.inputNullifiers[1]);
        vm.expectEmit(true, true, false, true, address(hub));
        emit IHubCore.NewCommitment(pi.outputCommitments[0], idx, e.encOut0);
        vm.expectEmit(true, true, false, true, address(hub));
        emit IHubCore.NewCommitment(pi.outputCommitments[1], idx + 1, e.encOut1);
        vm.expectEmit(true, false, false, true, address(hub));
        emit IHubCore.Spend(
            keccak256(abi.encode(pi.inputNullifiers[0], pi.inputNullifiers[1])), pi.root, ETH, w + fee + 20 * BUCKET
        );
        hub.transact(_proof(), pi, e, _bp());

        assertEq(usdc.balanceOf(bob), w);
        assertEq(usdc.balanceOf(relayer), 20 * BUCKET);
        assertTrue(hub.isSpent(pi.inputNullifiers[0]));
        assertTrue(hub.isSpent(pi.inputNullifiers[1]));
        assertEq(hub.shieldedSupply(), supplyBefore - (w + fee + 20 * BUCKET));
        assertEq(lm.available(ETH), lBefore - w - 20 * BUCKET);
        assertEq(hub.nextLeafIndex(), idx + 2);
        assertEq(lm.rewardPot() + lm.insurance(), fee - (fee - fee * 3000 / 10_000 - fee * 1000 / 10_000));
        assertEq(hub.releaseCount(ETH), 0);
    }

    function test_transact_withdrawToBase_logsRelease() public {
        uint256 w = 250e6;
        ExtData memory e = _ext(BASE, bob, w, BUCKET);
        PublicInputs memory pi = _pi(e);
        bytes32 spendId = keccak256(abi.encode(pi.inputNullifiers[0], pi.inputNullifiers[1]));
        Release memory r = Release({dstChainId: BASE, index: 0, recipient: bob, amount: w, spendId: spendId});

        vm.expectEmit(true, true, false, true, address(hub));
        emit IHubCore.ReleaseLogged(BASE, 0, bob, w, spendId);
        hub.transact(_proof(), pi, e, _bp());

        assertEq(hub.releaseCount(BASE), 1);
        assertEq(hub.releaseHash(BASE, 0), keccak256(abi.encode(r)));
        assertEq(lm.available(BASE), 1_000e6 - w);
        (uint8 kind, bytes memory body) = baseAdapter.lastMessage();
        assertEq(kind, MSG_RELEASE);
        assertEq(keccak256(body), keccak256(abi.encode(r)));
        assertEq(usdc.balanceOf(bob), 0);

        // second release gets index 1
        _transact(_ext(BASE, bob, w, 0));
        assertEq(hub.releaseCount(BASE), 2);
        assertTrue(hub.releaseHash(BASE, 1) != bytes32(0));
    }

    function test_transact_withdrawToArb_forwardsValue() public {
        arbAdapter.setMinValue(0.01 ether);
        vm.deal(address(this), 1 ether);
        ExtData memory e = _ext(ARB, bob, 10e6, 0);
        _transactValue(e, 0.02 ether);
        assertEq(arbAdapter.lastValue(), 0.02 ether);
        assertEq(address(arbAdapter).balance, 0.02 ether);
        assertEq(hub.releaseCount(ARB), 1);
    }

    function test_transact_withdrawToArb_insufficientValueReverts() public {
        arbAdapter.setMinValue(0.01 ether);
        ExtData memory e = _ext(ARB, bob, 10e6, 0);
        PublicInputs memory pi = _pi(e);
        vm.expectRevert();
        hub.transact(_proof(), pi, e, _bp());
    }

    function test_transact_transferWithRelayerFee() public {
        uint256 supplyBefore = hub.shieldedSupply();
        ExtData memory e = _ext(0, address(0), 0, 3 * BUCKET);
        _transact(e);
        assertEq(hub.shieldedSupply(), supplyBefore - 3 * BUCKET);
        assertEq(usdc.balanceOf(relayer), 3 * BUCKET);
        assertEq(baseAdapter.sentCount() + arbAdapter.sentCount(), 0);
    }

    function test_transact_zeroValueMerge() public {
        uint256 supplyBefore = hub.shieldedSupply();
        ExtData memory e = _ext(0, address(0), 0, 0);
        e.relayer = address(0);
        PublicInputs memory pi = _transact(e);
        assertEq(pi.publicAmount, 0);
        assertEq(hub.shieldedSupply(), supplyBefore);
    }

    function test_transact_relayerFeeFallsBackToClaimable() public {
        // Drain L[ETH] so the relayer fee can't be paid at once.
        _transact(_ext(ETH, bob, 998e6, 0));
        uint256 lEth = lm.available(ETH);
        uint256 fee = lEth + BUCKET - (lEth % BUCKET);
        _transact(_ext(BASE, bob, 10e6, fee));
        assertEq(lm.claimable(relayer), fee);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    function test_transact_rootFromHistoryAccepted() public {
        uint256 oldRoot = hub.getLastRoot();
        for (uint256 i; i < 99; ++i) {
            _depositEth(1e6);
        }
        assertTrue(hub.isKnownRoot(oldRoot));
        ExtData memory e = _ext(0, address(0), 0, 0);
        PublicInputs memory pi = _pi(e);
        pi.root = oldRoot;
        hub.transact(_proof(), pi, e, _bp());
    }

    // ================================================================== transact: every check (PRD 7.4 order)

    function _expectTransactRevert(ExtData memory e, PublicInputs memory pi, bytes memory err) internal {
        vm.expectRevert(err);
        hub.transact(_proof(), pi, e, _bp());
    }

    function _good() internal returns (ExtData memory e, PublicInputs memory pi) {
        e = _ext(ETH, bob, 10e6, BUCKET);
        pi = _pi(e);
    }

    function test_check1_spendsPaused() public {
        vm.prank(guardian);
        hub.emergencyPauseSpends();
        (ExtData memory e, PublicInputs memory pi) = _good();
        e.version = 9; // later checks also fail: the breaker must fire first
        _expectTransactRevert(
            e, pi, abi.encodeWithSelector(IHubCore.SpendsPaused.selector, uint64(block.timestamp + 72 hours))
        );
    }

    function test_check2_badVersion() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        e.version = 2;
        e.hub = address(1); // also wrong, but version is checked first
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.BadVersion.selector));
    }

    function test_check2_badHubChain() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        e.hubChainId = 1;
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.BadHubChain.selector));
    }

    function test_check2_badHub() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        e.hub = address(lm);
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.BadHub.selector));
    }

    function test_check2_expired() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        e.deadline = uint64(block.timestamp - 1);
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.Expired.selector));
    }

    function test_check2_deadlineNowAccepted() public {
        ExtData memory e = _ext(ETH, bob, 10e6, BUCKET);
        e.deadline = uint64(block.timestamp);
        _transact(e);
    }

    function test_check2_encOutTooLong() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        e.encOut0 = new bytes(257);
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.EncOutTooLong.selector));
        e.encOut0 = hex"";
        e.encOut1 = new bytes(257);
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.EncOutTooLong.selector));
    }

    function test_check2_encOut256Accepted() public {
        ExtData memory e = _ext(ETH, bob, 10e6, BUCKET);
        e.encOut0 = new bytes(256);
        e.encOut1 = new bytes(256);
        _transact(e);
    }

    function test_check3_transferShape() public {
        ExtData memory e = _ext(0, address(0), 0, 0);
        e.recipient = bob;
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadWithdrawShape.selector));
        e = _ext(0, address(0), 0, 0);
        e.withdrawAmount = 1;
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadWithdrawShape.selector));
        e = _ext(0, address(0), 0, 0);
        e.protocolFee = 1;
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadWithdrawShape.selector));
    }

    function test_check3_unsupportedChain() public {
        ExtData memory e = _ext(777, bob, 10e6, 0);
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, uint64(777)));
    }

    function test_check3_zeroRecipient() public {
        ExtData memory e = _ext(BASE, address(0), 10e6, 0);
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadWithdrawShape.selector));
    }

    function test_check3_belowMinWithdraw() public {
        ExtData memory e = _ext(ETH, bob, MIN_W - 1, 0);
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BelowMinWithdraw.selector));
        e = _ext(BASE, bob, 0, 0);
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BelowMinWithdraw.selector));
        _transact(_ext(ETH, bob, MIN_W, 0)); // boundary accepted
    }

    function test_check3_protocolFeeMustBeCeil() public {
        // w = 1_000_001: w * 10 / 1e4 = 1000.001 -> ceil 1001
        ExtData memory e = _ext(ETH, bob, 1_000_001, 0);
        assertEq(e.protocolFee, 1001);
        e.protocolFee = 1000; // floor
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadProtocolFee.selector));
        e.protocolFee = 1002;
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadProtocolFee.selector));
        e.protocolFee = 1001;
        _transact(e);
    }

    function test_check4_relayerFeeBucket() public {
        ExtData memory e = _ext(ETH, bob, 10e6, BUCKET + 1);
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadRelayerFee.selector));
    }

    function test_check4_relayerZeroWithFee() public {
        ExtData memory e = _ext(ETH, bob, 10e6, BUCKET);
        e.relayer = address(0);
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(IHubCore.BadRelayerFee.selector));
    }

    function test_check5_amountTooLarge() public {
        PublicInputs memory pi = _pi(_ext(0, address(0), 0, 0)); // publicAmount irrelevant: check 5 fires first
        ExtData memory e = _ext(0, address(0), 0, 0);
        e.relayerFee = (AMOUNT_BOUND / BUCKET) * BUCKET; // multiple of bucket, < 2^248
        e.relayerFee += BUCKET; // now >= 2^248
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.AmountTooLarge.selector));

        // Each term below the bound but the sum above it.
        e = _ext(ETH, bob, 10e6, 0);
        e.withdrawAmount = AMOUNT_BOUND - 1;
        e.protocolFee = Math.mulDiv(AMOUNT_BOUND - 1, PHI_BPS, 10_000, Math.Rounding.Ceil);
        e.relayerFee = (AMOUNT_BOUND / 2 / BUCKET) * BUCKET;
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.AmountTooLarge.selector));

        // Huge w that would overflow w * phi in naive math must not panic.
        e = _ext(ETH, bob, 10e6, 0);
        e.withdrawAmount = type(uint256).max;
        e.protocolFee = Math.mulDiv(type(uint256).max, PHI_BPS, 10_000, Math.Rounding.Ceil);
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.AmountTooLarge.selector));
    }

    function test_check5_badPublicAmount() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        pi.publicAmount += 1;
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.BadPublicAmount.selector));
        // v == 0 requires publicAmount == 0 (not P)
        e = _ext(0, address(0), 0, 0);
        pi = _pi(e);
        pi.publicAmount = P;
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.BadPublicAmount.selector));
    }

    function test_check6_unknownRoot() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        pi.root = 12345;
        pi.inputNullifiers[1] = pi.inputNullifiers[0]; // later check also fails
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.UnknownRoot.selector));
        pi.root = 0;
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.UnknownRoot.selector));
    }

    function test_check6_expiredRoot() public {
        uint256 oldRoot = hub.getLastRoot();
        for (uint256 i; i < 100; ++i) {
            _depositEth(1e6);
        }
        assertFalse(hub.isKnownRoot(oldRoot));
        (ExtData memory e, PublicInputs memory pi) = _good();
        pi.root = oldRoot;
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.UnknownRoot.selector));
    }

    function test_check6_fieldOverflow() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        PublicInputs memory bad;

        bad = _clone(pi);
        bad.extDataHash = pi.extDataHash + P;
        _expectTransactRevert(e, bad, abi.encodeWithSelector(IHubCore.FieldOverflow.selector));
        bad = _clone(pi);
        bad.inputNullifiers[0] = pi.inputNullifiers[0] + P;
        _expectTransactRevert(e, bad, abi.encodeWithSelector(IHubCore.FieldOverflow.selector));
        bad = _clone(pi);
        bad.inputNullifiers[1] = pi.inputNullifiers[1] + P;
        _expectTransactRevert(e, bad, abi.encodeWithSelector(IHubCore.FieldOverflow.selector));
        bad = _clone(pi);
        bad.outputCommitments[0] = P;
        _expectTransactRevert(e, bad, abi.encodeWithSelector(IHubCore.FieldOverflow.selector));
        bad = _clone(pi);
        bad.outputCommitments[1] = type(uint256).max;
        _expectTransactRevert(e, bad, abi.encodeWithSelector(IHubCore.FieldOverflow.selector));
    }

    function test_check7_duplicateNullifier() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        pi.inputNullifiers[1] = pi.inputNullifiers[0];
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.DuplicateNullifier.selector));
    }

    function test_check7_nullifierSpent() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        hub.transact(_proof(), pi, e, _bp());

        ExtData memory e2 = _ext(ETH, bob, 10e6, BUCKET);
        PublicInputs memory pi2 = _pi(e2);
        pi2.inputNullifiers[0] = pi.inputNullifiers[1];
        pi2.extDataHash = 0; // later check also fails
        _expectTransactRevert(e2, pi2, abi.encodeWithSelector(IHubCore.NullifierSpent.selector, pi.inputNullifiers[1]));
        pi2 = _pi(e2);
        pi2.inputNullifiers[1] = pi.inputNullifiers[0];
        _expectTransactRevert(e2, pi2, abi.encodeWithSelector(IHubCore.NullifierSpent.selector, pi.inputNullifiers[0]));
    }

    function test_check8_badExtDataHash() public {
        (ExtData memory e, PublicInputs memory pi) = _good();
        verifier.setResult(false); // later check also fails
        e.encOut1 = hex"cc"; // any field change breaks the binding
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.BadExtDataHash.selector));
    }

    function test_check9_invalidProof() public {
        verifier.setResult(false);
        (ExtData memory e, PublicInputs memory pi) = _good();
        e.withdrawAmount = 5_000e6; // liquidity would also fail
        e.protocolFee = _protocolFee(5_000e6);
        pi = _pi(e);
        _expectTransactRevert(e, pi, abi.encodeWithSelector(IHubCore.InvalidProof.selector));
    }

    function test_check10_insufficientLiquidity() public {
        ExtData memory e = _ext(BASE, bob, 1_000e6 + 1, 0);
        _expectTransactRevert(e, _pi(e), abi.encodeWithSelector(ILiquidityManager.InsufficientLiquidity.selector, BASE));
    }

    function test_unexpectedValue() public {
        vm.deal(address(this), 1 ether);
        ExtData memory e = _ext(ETH, bob, 10e6, 0);
        PublicInputs memory pi = _pi(e);
        vm.expectRevert(IHubCore.UnexpectedValue.selector);
        hub.transact{value: 1}(_proof(), pi, e, _bp());

        e = _ext(0, address(0), 0, 0);
        pi = _pi(e);
        vm.expectRevert(IHubCore.UnexpectedValue.selector);
        hub.transact{value: 1}(_proof(), pi, e, _bp());
    }

    function test_transact_shieldedSupplyUnderflowReverts() public {
        // A (hypothetically) unsound proof can't take out more than was put in.
        uint256 s = hub.shieldedSupply();
        usdc.mint(address(lm), 0);
        _depositL2(BASE, 0); // no-op on value
        ExtData memory e = _ext(0, address(0), 0, ((s / BUCKET) + 1) * BUCKET);
        PublicInputs memory pi = _pi(e);
        vm.expectRevert();
        hub.transact(_proof(), pi, e, _bp());
    }

    function _clone(PublicInputs memory a) internal pure returns (PublicInputs memory b) {
        b.root = a.root;
        b.publicAmount = a.publicAmount;
        b.extDataHash = a.extDataHash;
        b.inputNullifiers = [a.inputNullifiers[0], a.inputNullifiers[1]];
        b.outputCommitments = [a.outputCommitments[0], a.outputCommitments[1]];
    }

    // ================================================================== resendRelease

    function _logBaseRelease() internal returns (Release memory r) {
        ExtData memory e = _ext(BASE, bob, 50e6, 0);
        PublicInputs memory pi = _transact(e);
        r = Release({
            dstChainId: BASE,
            index: hub.releaseCount(BASE) - 1,
            recipient: bob,
            amount: 50e6,
            spendId: keccak256(abi.encode(pi.inputNullifiers[0], pi.inputNullifiers[1]))
        });
    }

    function test_resendRelease_anyone() public {
        Release memory r = _logBaseRelease();
        uint256 sentBefore = baseAdapter.sentCount();
        vm.expectEmit(true, true, false, false, address(hub));
        emit IHubCore.ReleaseResent(BASE, r.index);
        vm.prank(makeAddr("anyone"));
        hub.resendRelease(r, _bp());
        assertEq(baseAdapter.sentCount(), sentBefore + 1);
        (uint8 kind, bytes memory body) = baseAdapter.lastMessage();
        assertEq(kind, MSG_RELEASE);
        assertEq(keccak256(body), keccak256(abi.encode(r)));
        assertEq(baseAdapter.execCount(r.index), 1); // spoke-side idempotent
    }

    function test_resendRelease_forwardsValue() public {
        arbAdapter.setMinValue(1 gwei);
        vm.deal(address(this), 1 ether);
        ExtData memory e = _ext(ARB, bob, 10e6, 0);
        PublicInputs memory pi = _transactValue(e, 1 gwei);
        Release memory r = Release({
            dstChainId: ARB,
            index: 0,
            recipient: bob,
            amount: 10e6,
            spendId: keccak256(abi.encode(pi.inputNullifiers[0], pi.inputNullifiers[1]))
        });
        hub.resendRelease{value: 5 gwei}(r, _bp());
        assertEq(arbAdapter.lastValue(), 5 gwei);
    }

    function test_resendRelease_rejectsTampered() public {
        Release memory r = _logBaseRelease();
        r.amount += 1;
        vm.expectRevert(IHubCore.UnknownRelease.selector);
        hub.resendRelease(r, _bp());
        r.amount -= 1;
        r.recipient = alice;
        vm.expectRevert(IHubCore.UnknownRelease.selector);
        hub.resendRelease(r, _bp());
    }

    function test_resendRelease_rejectsUnknownIndex() public {
        Release memory r = _logBaseRelease();
        r.index += 1;
        vm.expectRevert(IHubCore.UnknownRelease.selector);
        hub.resendRelease(r, _bp());
    }

    function test_resendRelease_rejectsWrongChain() public {
        Release memory r = _logBaseRelease();
        r.dstChainId = ARB;
        vm.expectRevert(IHubCore.UnknownRelease.selector);
        hub.resendRelease(r, _bp());
        r.dstChainId = ETH;
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, ETH));
        hub.resendRelease(r, _bp());
        r.dstChainId = 0;
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, uint64(0)));
        hub.resendRelease(r, _bp());
    }

    function test_nonReentrant() public {
        ReentrantAdapter bad = new ReentrantAdapter();
        HubCoreConfig memory c = _hubConfig();
        c.baseAdapter = address(bad);
        // Separate hub whose LM is a stub that accepts everything.
        StubLM stub = new StubLM();
        c.liquidityManager = address(stub);
        c.depositManager = address(this);
        HubCore h2 = new HubCore(c);
        bad.setHub(address(h2));
        uint256[] memory cs = new uint256[](1);
        cs[0] = 1;
        h2.insertDepositLeaves(cs, 1_000e6);

        ExtData memory e = _ext(BASE, bob, 10e6, 0);
        e.hub = address(h2);
        PublicInputs memory pi;
        pi.root = h2.getLastRoot();
        uint256 v = 10e6 + e.protocolFee;
        pi.publicAmount = P - v;
        pi.extDataHash = _extHash(e);
        pi.inputNullifiers = [uint256(1), uint256(2)];
        pi.outputCommitments = [uint256(3), uint256(4)];
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        h2.transact(_proof(), pi, e, _bp());
    }

    // ================================================================== guardian (PRD 7.9)

    function test_guardian_onlyGuardian() public {
        vm.startPrank(alice);
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.setInflowsPaused(true);
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.pauseSpokeDeposits(BASE, true, _bp());
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.emergencyPauseSpends();
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.renounceGuardian();
        vm.stopPrank();
    }

    function test_guardian_setInflowsPaused() public {
        vm.expectEmit(false, false, false, true, address(hub));
        emit IHubCore.InflowsPaused(true);
        vm.prank(guardian);
        hub.setInflowsPaused(true);
        assertTrue(hub.inflowsPaused());
        // Exits are never affected.
        _transact(_ext(ETH, bob, 10e6, 0));
        vm.prank(guardian);
        hub.setInflowsPaused(false);
        assertFalse(hub.inflowsPaused());
    }

    function test_guardian_pauseSpokeDeposits() public {
        vm.expectEmit(true, false, false, true, address(hub));
        emit IHubCore.SpokeDepositsPauseSent(BASE, true);
        vm.prank(guardian);
        hub.pauseSpokeDeposits(BASE, true, _bp());
        (uint8 kind, bytes memory body) = baseAdapter.lastMessage();
        assertEq(kind, MSG_PAUSE);
        assertEq(abi.decode(body, (bool)), true);

        arbAdapter.setMinValue(1 gwei);
        vm.deal(guardian, 1 ether);
        vm.prank(guardian);
        hub.pauseSpokeDeposits{value: 1 gwei}(ARB, false, _bp());
        (kind, body) = arbAdapter.lastMessage();
        assertEq(kind, MSG_PAUSE);
        assertEq(abi.decode(body, (bool)), false);
    }

    function test_guardian_pauseSpokeDeposits_unsupported() public {
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, ETH));
        hub.pauseSpokeDeposits(ETH, true, _bp());
        vm.expectRevert(abi.encodeWithSelector(IHubCore.UnsupportedChain.selector, uint64(5)));
        hub.pauseSpokeDeposits(5, true, _bp());
        vm.stopPrank();
    }

    function test_guardian_emergencyPause_72hThenAuto() public {
        vm.expectEmit(false, false, false, true, address(hub));
        emit IHubCore.EmergencySpendPause(uint64(block.timestamp + 72 hours));
        vm.prank(guardian);
        hub.emergencyPauseSpends();
        assertEq(hub.spendsPausedUntil(), block.timestamp + 72 hours);

        ExtData memory e = _ext(ETH, bob, 10e6, 0);
        e.deadline = uint64(block.timestamp + 10 days);
        PublicInputs memory pi = _pi(e);
        vm.warp(block.timestamp + 72 hours - 1);
        vm.expectRevert();
        hub.transact(_proof(), pi, e, _bp());
        vm.warp(block.timestamp + 1);
        hub.transact(_proof(), pi, e, _bp()); // auto-unpaused
    }

    function test_guardian_emergencyPause_notExtendable() public {
        vm.startPrank(guardian);
        hub.emergencyPauseSpends();
        uint64 until = hub.spendsPausedUntil();
        vm.warp(block.timestamp + 71 hours);
        vm.expectRevert(IHubCore.EmergencyCooldown.selector);
        hub.emergencyPauseSpends();
        assertEq(hub.spendsPausedUntil(), until);
        vm.stopPrank();
    }

    function test_guardian_emergencyPause_cooldown30Days() public {
        vm.startPrank(guardian);
        uint256 t0 = block.timestamp;
        hub.emergencyPauseSpends();
        vm.warp(t0 + 30 days - 1);
        vm.expectRevert(IHubCore.EmergencyCooldown.selector);
        hub.emergencyPauseSpends();
        vm.warp(t0 + 30 days);
        hub.emergencyPauseSpends();
        assertEq(hub.spendsPausedUntil(), t0 + 30 days + 72 hours);
        assertEq(hub.lastEmergencyPause(), t0 + 30 days);
        vm.stopPrank();
    }

    function test_guardian_pauseDoesNotBlockDepositsOrResend() public {
        Release memory r = _logBaseRelease();
        vm.prank(guardian);
        hub.emergencyPauseSpends();
        _depositEth(5e6);
        hub.resendRelease(r, _bp());
    }

    function test_guardian_renounce() public {
        vm.expectEmit(false, false, false, false, address(hub));
        emit IHubCore.GuardianRenounced();
        vm.prank(guardian);
        hub.renounceGuardian();
        assertEq(hub.guardian(), address(0));
        vm.startPrank(guardian);
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.setInflowsPaused(true);
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.emergencyPauseSpends();
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.renounceGuardian();
        vm.expectRevert(ILiquidityManager.OnlyGuardian.selector);
        lm.setTargets(3000, 3500, 3500);
        vm.stopPrank();
        vm.prank(address(0));
        vm.expectRevert(IHubCore.OnlyGuardian.selector);
        hub.setInflowsPaused(true);
    }

    function test_guardian_cannotMoveFunds() public {
        uint256 bal = usdc.balanceOf(address(lm));
        vm.startPrank(guardian);
        hub.setInflowsPaused(true);
        hub.pauseSpokeDeposits(BASE, true, _bp());
        hub.emergencyPauseSpends();
        lm.setTargets(6000, 2000, 2000);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.payOnL1(guardian, 1);
        vm.expectRevert(ILiquidityManager.Unauthorized.selector);
        lm.reserve(ETH, 1);
        hub.renounceGuardian();
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(lm)), bal);
        assertEq(usdc.balanceOf(guardian), 0);
    }
}

/// @dev Minimal LM stand-in for the reentrancy test (accepts every ledger call).
contract StubLM {
    function reserve(uint64, uint256) external {}
    function accrueProtocolFee(uint256) external {}
    function payRelayer(address, uint256) external {}
    function payOnL1(address, uint256) external {}
}
