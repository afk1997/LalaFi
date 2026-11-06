// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FastlaneBase} from "./FastlaneBase.sol";
import {IDepositManager} from "../../src/interfaces/IDepositManager.sol";
import {IStakeManager} from "../../src/interfaces/IStakeManager.sol";
import {DepositManager} from "../../src/hub/DepositManager.sol";
import {DepositManagerConfig} from "../../src/libraries/DeployConfig.sol";
import {L2Deposit, Checkpoint, P, FRAUD_MISMATCH, FRAUD_ABSENCE} from "../../src/libraries/Types.sol";
import {MockHubAdapter} from "./mocks/FastlaneMocks.sol";

contract DepositManagerTest is FastlaneBase {
    uint256 internal constant BOND = 20_000e6;
    uint256 internal constant ALLOC = 10_000e6;

    function setUp() public override {
        super.setUp();
        _addValidators(7, BOND, ALLOC, ALLOC);
        _advance(); // epoch 1: all 7 active with 10k on each chain
    }

    // ================================================================== poseidon / constructor

    function test_poseidonKnownVector() public view {
        // circomlib Poseidon(3)([1,2,3])
        assertEq(
            IPoseidonT4Like(poseidon).hash([uint256(1), 2, 3]),
            6542985608222806190361240322586112750744169038454362455181422643027100751666
        );
    }

    function test_constructor_rejectsBadConfig() public {
        DepositManagerConfig memory c = _dmConfig();
        c.stakeManager = address(sm);
        c.minDeposit = 0;
        vm.expectRevert(DepositManager.BadConfig.selector);
        new DepositManager(c);

        c = _dmConfig();
        c.stakeManager = address(sm);
        c.arbChainId = BASE;
        vm.expectRevert(DepositManager.BadConfig.selector);
        new DepositManager(c);

        c = _dmConfig();
        c.stakeManager = address(sm);
        c.maxFastDeposit = c.maxFastDepositHardMax + 1;
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        new DepositManager(c);
    }

    // ================================================================== L1 deposit

    function _l1Deposit(address user, uint256 amount, uint256 owner) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(dm), amount);
        dm.deposit(amount, owner, hex"c0ffee");
        vm.stopPrank();
    }

    function test_deposit_success() public {
        address user = makeAddr("user");
        uint256 owner = _digestOf(1);
        uint256 c = _commit(5e6, owner);
        usdc.mint(user, 5e6);
        vm.startPrank(user);
        usdc.approve(address(dm), 5e6);
        vm.expectEmit(address(dm));
        emit IDepositManager.L1Deposit(0, c, 5e6, user, hex"c0ffee");
        dm.deposit(5e6, owner, hex"c0ffee");
        vm.stopPrank();
        assertEq(hub.leaves(0), c);
        assertEq(hub.leaves(1), 0); // Z0 pad
        assertEq(hub.shieldedSupply(), 5e6);
        assertEq(usdc.balanceOf(address(lm)), 5e6);
        assertEq(lm.available(uint64(block.chainid)), 5e6);
        assertEq(usdc.balanceOf(address(dm)), 0);
    }

    function test_deposit_reverts() public {
        address user = makeAddr("user");
        usdc.mint(user, 10_000e6);
        vm.startPrank(user);
        usdc.approve(address(dm), type(uint256).max);
        vm.expectRevert(IDepositManager.BadAmount.selector);
        dm.deposit(MIN_DEP - 1, 1, "");
        vm.expectRevert(IDepositManager.BadAmount.selector);
        dm.deposit(1_000e6 + 1, 1, "");
        vm.expectRevert(IDepositManager.FieldOverflow.selector);
        dm.deposit(MIN_DEP, P, "");
        vm.expectRevert(IDepositManager.EncNoteTooLong.selector);
        dm.deposit(MIN_DEP, 1, new bytes(257));
        dm.deposit(MIN_DEP, 1, new bytes(256)); // boundary ok
        vm.stopPrank();

        hub.setInflowsPaused(true);
        vm.prank(user);
        vm.expectRevert(IDepositManager.InflowsPaused.selector);
        dm.deposit(MIN_DEP, 1, "");
        hub.setInflowsPaused(false);

        // TVL cap = vault balance + amount
        uint256 cap = usdc.balanceOf(address(lm)) + 2e6;
        vm.prank(guardian);
        dm.setCaps(1_000e6, 10_000e6, cap, 1, 2);
        vm.startPrank(user);
        dm.deposit(2e6, 1, ""); // exactly at the cap
        vm.expectRevert(IDepositManager.TvlCapExceeded.selector);
        dm.deposit(MIN_DEP, 1, "");
        vm.stopPrank();
    }

    // ================================================================== submitAttestation

    function test_attest_success() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 4, 100e6);
        uint256 batchId = _attest(BASE, 1, ds, _allPks());
        assertEq(batchId, 1);
        assertEq(dm.batchCount(), 1);
        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Pending));
        assertEq(dm.unconfirmedFastValue(), 400e6);
        for (uint256 i; i < 4; ++i) {
            assertTrue(dm.inserted(BASE, uint64(i)));
            assertFalse(dm.confirmed(BASE, uint64(i)));
            assertEq(hub.leaves(i), _commit(100e6, ds[i].ownerDigest));
            (uint256 bid, bytes32 h) = dm.fastItem(BASE, uint64(i));
            assertEq(bid, 1);
            assertEq(h, keccak256(abi.encode(ds[i])));
        }
        // ledger untouched
        assertEq(lm.available(BASE), 0);
        assertEq(hub.shieldedSupply(), 400e6);
        // exposure: x_v = ceil(400e6 * 10k / 70k) each
        uint256 x = (400e6 * ALLOC + 70_000e6 - 1) / 70_000e6;
        uint32[] memory ids = dm.batchSigners(1);
        assertEq(ids.length, 7);
        for (uint256 i; i < 7; ++i) {
            assertEq(sm.exposure(ids[i], BASE), x);
            assertEq(sm.exposure(ids[i], ARB), 0);
        }
    }

    function test_attest_emitsEvents() public {
        L2Deposit[] memory ds = _spokeDeposits(ARB, 1, 100e6);
        (address[] memory signers, bytes[] memory sigs) = _signAll(ARB, 1, ds, _pks(0, 5));
        vm.expectEmit(address(dm));
        emit IDepositManager.L2DepositInserted(ARB, 0, _commit(100e6, ds[0].ownerDigest), 0, true);
        vm.expectEmit(address(dm));
        emit IDepositManager.BatchAttested(1, ARB, 1, 100e6, 0x1f, submitter);
        vm.prank(submitter);
        dm.submitAttestation(ARB, 1, ds, signers, sigs);
    }

    function test_attest_reverts_lane() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds, _allPks());

        hub.setInflowsPaused(true);
        vm.expectRevert(IDepositManager.InflowsPaused.selector);
        dm.submitAttestation(BASE, 1, ds, s, g);
        hub.setInflowsPaused(false);

        vm.expectRevert(abi.encodeWithSelector(IDepositManager.UnsupportedChain.selector, uint64(10)));
        dm.submitAttestation(10, 1, ds, s, g);

        vm.expectRevert(IDepositManager.BadEpoch.selector);
        dm.submitAttestation(BASE, 2, ds, s, g); // future
    }

    function test_attest_epochZeroGraceHasNoStake() public {
        // epoch 0 is a valid grace epoch at cur=1 but has no snapshot: signers have no allocation
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 0, ds, _allPks());
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.InvalidSigner.selector, s[0]));
        dm.submitAttestation(BASE, 0, ds, s, g);
    }

    function test_attest_reverts_batchSize() public {
        L2Deposit[] memory empty = new L2Deposit[](0);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, empty, _allPks());
        vm.expectRevert(IDepositManager.BadBatchSize.selector);
        dm.submitAttestation(BASE, 1, empty, s, g);

        L2Deposit[] memory big = _spokeDeposits(BASE, 33, 1e6);
        (s, g) = _signAll(BASE, 1, big, _allPks());
        vm.expectRevert(IDepositManager.BadBatchSize.selector);
        dm.submitAttestation(BASE, 1, big, s, g);
    }

    function test_attest_maxBatch32() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 32, 1e6);
        _attest(BASE, 1, ds, _allPks());
        assertEq(dm.unconfirmedFastValue(), 32e6);
    }

    function test_attest_reverts_items() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 2, 100e6);
        L2Deposit[] memory bad = _copy(ds);
        bad[1].ownerDigest = P;
        _expectAttestRevert(BASE, 1, bad, abi.encodeWithSelector(IDepositManager.FieldOverflow.selector));

        bad = _copy(ds);
        bad[0].amount = MIN_DEP - 1;
        _expectAttestRevert(BASE, 1, bad, abi.encodeWithSelector(IDepositManager.BadAmount.selector));

        bad = _copy(ds);
        bad[0].amount = 10_000e6 + 1;
        _expectAttestRevert(BASE, 1, bad, abi.encodeWithSelector(IDepositManager.BadAmount.selector));

        // duplicate index inside one batch
        bad = _copy(ds);
        bad[1].index = bad[0].index;
        _expectAttestRevert(
            BASE, 1, bad, abi.encodeWithSelector(IDepositManager.AlreadyInserted.selector, BASE, uint64(0))
        );

        // already inserted by a previous batch
        _attest(BASE, 1, _one(ds[0]), _allPks());
        _expectAttestRevert(
            BASE, 1, ds, abi.encodeWithSelector(IDepositManager.AlreadyInserted.selector, BASE, uint64(0))
        );
    }

    function test_attest_reverts_signers() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds, _allPks());

        // not ascending (swap)
        address[] memory s2 = _copyA(s);
        bytes[] memory g2 = _copyB(g);
        (s2[0], s2[1]) = (s2[1], s2[0]);
        (g2[0], g2[1]) = (g2[1], g2[0]);
        vm.expectRevert(IDepositManager.SignersNotAscending.selector);
        dm.submitAttestation(BASE, 1, ds, s2, g2);

        // duplicate signer
        s2 = _copyA(s);
        g2 = _copyB(g);
        s2[1] = s2[0];
        g2[1] = g2[0];
        vm.expectRevert(IDepositManager.SignersNotAscending.selector);
        dm.submitAttestation(BASE, 1, ds, s2, g2);

        // length mismatch
        bytes[] memory g3 = new bytes[](6);
        vm.expectRevert(IDepositManager.LengthMismatch.selector);
        dm.submitAttestation(BASE, 1, ds, s, g3);

        // unknown signer
        uint256[] memory keys = _allPks();
        keys[6] = 0xBAD;
        (s2, g2) = _signAll(BASE, 1, ds, keys);
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.InvalidSigner.selector, vm.addr(0xBAD)));
        dm.submitAttestation(BASE, 1, ds, s2, g2);

        // bad signature: signature from a different key under a registered address
        g2 = _copyB(g);
        g2[2] = _sig(0xBAD, dm.batchDigest(BASE, 1, ds));
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.BadSignature.selector, s[2]));
        dm.submitAttestation(BASE, 1, ds, s, g2);

        // malformed signature
        g2 = _copyB(g);
        g2[3] = hex"1234";
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.BadSignature.selector, s[3]));
        dm.submitAttestation(BASE, 1, ds, s, g2);

        // high-s malleated signature is rejected
        g2 = _copyB(g);
        g2[4] = _malleate(g[4]);
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.BadSignature.selector, s[4]));
        dm.submitAttestation(BASE, 1, ds, s, g2);

        // signature over another epoch / chain
        g2 = _copyB(g);
        g2[0] = _sig(_pkOf(s[0]), dm.batchDigest(ARB, 1, ds));
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.BadSignature.selector, s[0]));
        dm.submitAttestation(BASE, 1, ds, s, g2);
    }

    function test_attest_reverts_zeroAllocation() public {
        // validator with allocation only on ARB cannot sign for BASE
        (, uint256 pk) = _addValidator(BOND, 0, ALLOC);
        _advance();
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        uint256[] memory keys = new uint256[](8);
        for (uint256 i; i < 7; ++i) {
            keys[i] = pks[i];
        }
        keys[7] = pk;
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 2, ds, keys);
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.InvalidSigner.selector, vm.addr(pk)));
        dm.submitAttestation(BASE, 2, ds, s, g);
    }

    function test_attest_reverts_jailedSigner() public {
        vm.prank(address(dm));
        sm.slash(vids[0], 3, address(0), 0);
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds, _allPks());
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.InvalidSigner.selector, vm.addr(pks[0])));
        dm.submitAttestation(BASE, 1, ds, s, g);
    }

    // ------------------------------------------------------------------ R1 / R2 / R3 edges

    function test_R1_edge() public {
        // S = 70k; θ = 2/3 => need S_Q ≥ 46,666.67k => 5 signers (50k) pass, 4 (40k) fail.
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        _expectAttestRevertWith(BASE, 1, ds, _pks(0, 4), abi.encodeWithSelector(IDepositManager.QuorumR1.selector));
        _attest(BASE, 1, ds, _pks(0, 5));
    }

    function test_R1_exactBoundary() public {
        // fresh set: three validators with 100, 100, 100 → S = 300; two signers = 200 = θ·S exactly
        _deployAll();
        delete pks;
        delete operators;
        delete vids;
        // allocations 100, 100, 100 + 1 unit → S = 300e6 + 1, θ·S = 200e6 + 2/3
        _addValidator(200e6, 100e6, 0);
        _addValidator(200e6, 100e6, 0);
        _addValidator(200e6, 100e6 + 1, 0);
        _advance();
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 1e6);
        uint256[] memory two = new uint256[](2);
        two[0] = pks[0];
        two[1] = pks[1]; // S_Q = 200e6: 3·S_Q = 600e6 < 2·S = 600e6 + 2 → fails by one unit
        _expectAttestRevertWith(BASE, 1, ds, two, abi.encodeWithSelector(IDepositManager.QuorumR1.selector));
        two[1] = pks[2]; // S_Q = 200e6 + 1: 600e6 + 3 ≥ 600e6 + 2 → passes
        _attest(BASE, 1, ds, two);
    }

    function test_R2_edge() public {
        // single dominant validator: S_Q = s; R2 needs A ≤ (2/3)·s
        _deployAll();
        delete pks;
        delete operators;
        delete vids;
        _addValidator(3_000e6, 3_000e6, 0);
        _advance();
        // A = 2,000e6 is exactly s/k
        L2Deposit[] memory over = _spokeDeposits(BASE, 1, 2_000e6 + 1);
        _expectAttestRevertWith(BASE, 1, over, _allPks(), abi.encodeWithSelector(IDepositManager.QuorumR2.selector));
        L2Deposit[] memory ok = new L2Deposit[](1);
        ok[0] = _spokeDeposit(BASE, 2_000e6);
        _attest(BASE, 1, ok, _allPks());
        assertEq(sm.exposure(vids[0], BASE), 2_000e6);
    }

    function test_R3_edge_existingExposure() public {
        _deployAll();
        delete pks;
        delete operators;
        delete vids;
        _addValidator(300e6, 300e6, 0);
        _addValidator(300e6, 300e6, 0);
        _advance();
        // batch 1: A = 100e6 → x = 50e6 each; batch 2: A = 100e6 → e = 100e6 each = s/k... wait s/k = 200e6
        _attest(BASE, 1, _one(_spokeDeposit(BASE, 200e6)), _allPks()); // x = 100e6, e = 100e6
        _attest(BASE, 1, _one(_spokeDeposit(BASE, 200e6)), _allPks()); // e = 200e6 = s/k exactly
        assertEq(sm.exposure(vids[0], BASE), 200e6);
        // R2 still holds for a 1-USDC batch (600 ≥ 1.5) but R3 fails for the first signer
        L2Deposit[] memory ds = _one(_spokeDeposit(BASE, 1e6));
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds, _allPks());
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.QuorumR3.selector, s[0]));
        dm.submitAttestation(BASE, 1, ds, s, g);
    }

    function test_R3_ceilRounding() public {
        // x_v rounds up: A = 1,000,001 split over 3 equal signers
        _deployAll();
        delete pks;
        delete operators;
        delete vids;
        _addValidators(3, 300e6, 300e6, 0);
        _advance();
        _attest(BASE, 1, _one(_spokeDeposit(BASE, 1_000_001)), _allPks());
        uint128[] memory xs = dm.batchExposures(1);
        assertEq(xs[0], 333_334);
        assertEq(uint256(xs[0]) + xs[1] + xs[2], 1_000_002); // Σ x_v ≥ A
    }

    function test_safetyValve() public {
        lm.setLpAssets(1_000e6);
        lm.setInsurance(200e6); // β·(1200) = 600
        _attest(BASE, 1, _spokeDeposits(BASE, 2, 300e6), _allPks()); // U = 600 exactly
        L2Deposit[] memory ds = _one(_spokeDeposit(BASE, 1e6));
        _expectAttestRevertWith(BASE, 1, ds, _allPks(), abi.encodeWithSelector(IDepositManager.SafetyValve.selector));
    }

    // ------------------------------------------------------------------ epoch grace

    function test_epochGrace() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds, _allPks());
        _advance(); // cur = 2; signed for epoch 1 still accepted
        vm.prank(submitter);
        dm.submitAttestation(BASE, 1, ds, s, g);

        L2Deposit[] memory ds2 = _spokeDeposits(BASE, 1, 100e6);
        (s, g) = _signAll(BASE, 1, ds2, _allPks());
        _advance(); // cur = 3; epoch 1 too old
        vm.expectRevert(IDepositManager.BadEpoch.selector);
        dm.submitAttestation(BASE, 1, ds2, s, g);
    }

    function test_epochGrace_usesMinOfSnapshots() public {
        // validator 0 moves all its stake from BASE to ARB for epoch 2; in epoch 2 it can't sign a
        // BASE batch with its epoch-1 snapshot (would double-count the same stake on both chains)
        vm.prank(operators[0]);
        _setAlloc(0, 2 * ALLOC);
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds, _allPks());
        _advance();
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.InvalidSigner.selector, vm.addr(pks[0])));
        dm.submitAttestation(BASE, 1, ds, s, g);
        // without validator 0 it goes through
        (s, g) = _signAll(BASE, 1, ds, _pks(1, 7));
        dm.submitAttestation(BASE, 1, ds, s, g);
    }

    // ================================================================== checkpoints

    function test_receiveCheckpoint_auth_and_validation() public {
        _spokeDeposits(BASE, 3, 100e6);
        (uint64 seq, bytes memory body) = _sendCheckpoint(BASE, 64);
        DepositManager.CheckpointRec memory r = dm.checkpointOf(BASE, seq);
        assertEq(r.payloadHash, keccak256(body));
        assertEq(r.from, 0);
        assertEq(r.to, 3);
        assertEq(r.countAtSend, 3);
        assertEq(r.nextItem, 0);

        vm.expectRevert(IDepositManager.OnlyAdapter.selector);
        dm.receiveCheckpoint(BASE, body);
        vm.prank(address(arbAdapter));
        vm.expectRevert(IDepositManager.OnlyAdapter.selector);
        dm.receiveCheckpoint(BASE, body);
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.UnsupportedChain.selector, uint64(1)));
        dm.receiveCheckpoint(1, body);

        vm.expectRevert(IDepositManager.DuplicateCheckpoint.selector);
        baseAdapter.deliver(body);

        L2Deposit[] memory ds = new L2Deposit[](2);
        ds[0] = spokes[BASE].deps[0];
        ds[1] = spokes[BASE].deps[2]; // gap
        bytes memory bad = abi.encode(Checkpoint(9, 0, 2, 3, 99, ds));
        vm.expectRevert(IDepositManager.BadCheckpoint.selector);
        baseAdapter.deliver(bad);
        bad = abi.encode(Checkpoint(9, 0, 3, 3, 99, ds)); // to − from != len
        vm.expectRevert(IDepositManager.BadCheckpoint.selector);
        baseAdapter.deliver(bad);
        ds[1] = spokes[BASE].deps[1];
        bad = abi.encode(Checkpoint(9, 0, 2, 1, 99, ds)); // to > countAtSend
        vm.expectRevert(IDepositManager.BadCheckpoint.selector);
        baseAdapter.deliver(bad);
        bad = abi.encode(Checkpoint(9, 1, 3, 3, 99, ds)); // index != from + k
        vm.expectRevert(IDepositManager.BadCheckpoint.selector);
        baseAdapter.deliver(bad);
    }

    function test_processCheckpoint_reverts() public {
        _spokeDeposits(BASE, 2, 100e6);
        (uint64 seq, bytes memory body) = _sendCheckpoint(BASE, 64);
        vm.expectRevert(IDepositManager.UnknownCheckpoint.selector);
        dm.processCheckpoint(BASE, seq + 1, body, 0);
        vm.expectRevert(IDepositManager.PayloadMismatch.selector);
        dm.processCheckpoint(BASE, seq, abi.encodePacked(body, uint8(0)), 0);
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.UnsupportedChain.selector, uint64(5)));
        dm.processCheckpoint(5, seq, body, 0);
        dm.processCheckpoint(BASE, seq, body, 0);
        vm.expectRevert(DepositManager.CheckpointDone.selector);
        dm.processCheckpoint(BASE, seq, body, 0);
    }

    function test_slowLane_chunked() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 5, 100e6);
        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        _process(BASE, seq, 2);
        assertEq(dm.checkpointOf(BASE, seq).nextItem, 2);
        assertTrue(dm.confirmed(BASE, 1));
        assertFalse(dm.confirmed(BASE, 2));
        assertEq(hub.leafCount(), 2);
        _process(BASE, seq, 2);
        assertEq(hub.leafCount(), 4);
        _process(BASE, seq, 2); // last item, padded
        assertEq(hub.leafCount(), 6);
        assertEq(dm.checkpointOf(BASE, seq).nextItem, 5);
        for (uint256 i; i < 5; ++i) {
            assertTrue(dm.inserted(BASE, uint64(i)));
            assertTrue(dm.confirmed(BASE, uint64(i)));
            assertEq(hub.leaves(i), _commit(100e6, ds[i].ownerDigest));
        }
        assertEq(hub.leaves(5), 0);
        uint256 fee = BASE_INS + BASE_FIN;
        assertEq(lm.available(BASE), 5 * (100e6 + fee));
        assertEq(lm.claimable(processor), 5 * fee); // insert + final for slow items
        assertEq(hub.shieldedSupply(), 500e6);
        assertEq(dm.unconfirmedFastValue(), 0);
    }

    function test_slowLane_events() public {
        L2Deposit[] memory ds = _spokeDeposits(ARB, 1, 100e6);
        (uint64 seq,) = _sendCheckpoint(ARB, 64);
        vm.expectEmit(address(dm));
        emit IDepositManager.DepositConfirmed(ARB, 0);
        vm.expectEmit(address(dm));
        emit IDepositManager.L2DepositInserted(ARB, 0, _commit(100e6, ds[0].ownerDigest), 0, false);
        vm.expectEmit(address(dm));
        emit IDepositManager.CheckpointProcessed(ARB, seq, 1, true);
        _process(ARB, seq, 0);
    }

    function test_fastConfirm_fullBatch() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 3, 100e6);
        _attest(BASE, 1, ds, _allPks());
        uint32[] memory ids = dm.batchSigners(1);
        (uint64 seq,) = _sendCheckpoint(BASE, 2); // covers items 0,1 only
        _process(BASE, seq, 0);
        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Pending));
        assertGt(sm.exposure(ids[0], BASE), 0);
        assertEq(dm.unconfirmedFastValue(), 300e6);
        assertEq(lm.claimable(submitter), 0);

        (seq,) = _sendCheckpoint(BASE, 2);
        vm.expectEmit(address(dm));
        emit IDepositManager.BatchConfirmed(1);
        _process(BASE, seq, 0);
        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Confirmed));
        for (uint256 i; i < 7; ++i) {
            assertEq(sm.exposure(ids[i], BASE), 0);
        }
        assertEq(dm.unconfirmedFastValue(), 0);
        assertEq(lm.available(BASE), 3 * (100e6 + BASE_INS + BASE_FIN));
        assertEq(lm.claimable(submitter), 3 * BASE_INS);
        assertEq(lm.claimable(processor), 3 * BASE_FIN);
        assertEq(hub.leafCount(), 4); // no extra leaves from confirmation
        assertEq(hub.shieldedSupply(), 300e6);
    }

    function test_mismatch_slashesAndInsertsTrueLeaf() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 2, 100e6);
        L2Deposit[] memory fake = _copy(ds);
        fake[1].amount = 9_000e6; // inflated
        _attest(BASE, 1, fake, _allPks());
        assertEq(dm.unconfirmedFastValue(), 9_100e6);
        uint256 stakeBefore = sm.totalStake();

        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        vm.expectEmit(address(dm));
        emit IDepositManager.FraudProven(1, FRAUD_MISMATCH, processor);
        _process(BASE, seq, 0);

        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Fraud));
        assertEq(dm.unconfirmedFastValue(), 0);
        for (uint256 i; i < 7; ++i) {
            (, , bool jailed) = sm.validatorBySigner(vm.addr(pks[i]));
            assertTrue(jailed);
        }
        assertEq(sm.totalStake(), stakeBefore - 7 * BOND);
        // true commitment for item 1 inserted after the 2 fast leaves
        assertEq(hub.leaves(2), _commit(100e6, ds[1].ownerDigest));
        assertEq(hub.shieldedSupply(), 9_100e6 + 100e6);
        assertTrue(dm.confirmed(BASE, 0) && dm.confirmed(BASE, 1));
        assertEq(lm.available(BASE), 2 * (100e6 + BASE_INS + BASE_FIN) + 0);
        // item 0 matched (fraud batch → insert bounty to processor), item 1 slow-like
        assertEq(lm.claimable(processor), 2 * (BASE_INS + BASE_FIN));
        assertEq(lm.claimable(submitter), 0);
        // insurance covers the fake value
        assertGe(lm.totalSlashedReceived(), 9_000e6);
    }

    function test_duplicateIndexAcrossCheckpoints_notCreditedTwice() public {
        _spokeDeposits(BASE, 2, 100e6);
        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        _process(BASE, seq, 0);
        uint256 avail = lm.available(BASE);
        // a buggy spoke re-sends the same range under a new seq
        L2Deposit[] memory ds = new L2Deposit[](2);
        ds[0] = spokes[BASE].deps[0];
        ds[1] = spokes[BASE].deps[1];
        bytes memory body = abi.encode(Checkpoint(77, 0, 2, 2, 1000, ds));
        baseAdapter.deliver(body);
        dm.processCheckpoint(BASE, 77, body, 0);
        assertEq(lm.available(BASE), avail);
        assertEq(hub.leafCount(), 2);
    }

    // ================================================================== proveAbsence

    function test_absence_viaEmptyCheckpoint() public {
        // coalition attests a non-existent future index 5 claiming l2Block 1
        L2Deposit[] memory fake = new L2Deposit[](1);
        fake[0] = L2Deposit({index: 5, ownerDigest: 7, amount: 5_000e6, fee: 0, l2Block: 1});
        _attest(ARB, 1, fake, _allPks());
        (uint64 seq,) = _sendCheckpoint(ARB, 64); // empty: countAtSend 0, l2Block 1
        _bumpL2(ARB);
        (seq,) = _sendCheckpoint(ARB, 64); // empty: countAtSend 0, l2Block 3
        // first checkpoint at l2Block 1: d.l2Block (1) is not < 1 → not fraud
        vm.expectRevert(IDepositManager.NotFraud.selector);
        dm.proveAbsence(ARB, 0, 1, fake, 0);
        vm.expectEmit(address(dm));
        emit IDepositManager.FraudProven(1, FRAUD_ABSENCE, address(this));
        dm.proveAbsence(ARB, seq, 1, fake, 0);
        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Fraud));
        assertEq(dm.unconfirmedFastValue(), 0);
        assertGe(lm.totalSlashedReceived(), 5_000e6);
        // prover got a reward
        assertGt(usdc.balanceOf(address(this)), 0);
        vm.expectRevert(DepositManager.AlreadySlashed.selector);
        dm.proveAbsence(ARB, seq, 1, fake, 0);
    }

    function test_absence_reverts() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 2, 100e6);
        _attest(BASE, 1, ds, _allPks());
        (uint64 seq,) = _sendCheckpoint(BASE, 64);

        vm.expectRevert(IDepositManager.UnknownCheckpoint.selector);
        dm.proveAbsence(BASE, seq + 1, 1, ds, 0);
        vm.expectRevert(IDepositManager.UnknownBatch.selector);
        dm.proveAbsence(BASE, seq, 2, ds, 0);
        vm.expectRevert(IDepositManager.UnknownBatch.selector);
        dm.proveAbsence(BASE, seq, 0, ds, 0);
        vm.expectRevert(IDepositManager.BatchDataMismatch.selector);
        dm.proveAbsence(BASE, seq, 1, ds, 2);
        L2Deposit[] memory other = _copy(ds);
        other[0].amount += 1;
        vm.expectRevert(IDepositManager.BatchDataMismatch.selector);
        dm.proveAbsence(BASE, seq, 1, other, 0);
        // existing deposits: index < countAtSend
        vm.expectRevert(IDepositManager.NotFraud.selector);
        dm.proveAbsence(BASE, seq, 1, ds, 1);
        // batch on another chain
        (uint64 aseq,) = _sendCheckpoint(ARB, 64);
        vm.expectRevert(IDepositManager.BatchDataMismatch.selector);
        dm.proveAbsence(ARB, aseq, 1, ds, 0);
    }

    function test_absence_confirmedBatchIsNotFraud() public {
        // honest deposit at index 0 l2Block 1, confirmed; a later empty checkpoint can't prove absence
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        _attest(BASE, 1, ds, _allPks());
        _checkpointAll(BASE);
        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        vm.expectRevert(IDepositManager.NotFraud.selector);
        dm.proveAbsence(BASE, seq, 1, ds, 0);
    }

    // ================================================================== proveEquivocation

    function test_equivocation_unsubmitted() public {
        L2Deposit memory d = _spokeDeposit(BASE, 100e6);
        L2Deposit memory d2 = L2Deposit(d.index, d.ownerDigest, d.amount, d.fee, d.l2Block);
        d2.amount = 200e6;
        L2Deposit[] memory a = _one(d);
        L2Deposit[] memory b = _one(d2);
        uint256 pk = pks[3];
        bytes memory sa = _sig(pk, dm.batchDigest(BASE, 1, a));
        bytes memory sb = _sig(pk, dm.batchDigest(BASE, 2, b));
        address prover = makeAddr("prover");
        vm.prank(prover);
        vm.expectEmit(address(dm));
        emit IDepositManager.FraudProven(0, 3, prover);
        dm.proveEquivocation(BASE, vm.addr(pk), 1, a, sa, 0, 2, b, sb, 0);
        (,, bool jailed) = sm.validatorBySigner(vm.addr(pk));
        assertTrue(jailed);
        // coveredLoss 0, no exposure: prover gets ω·Σ
        assertEq(usdc.balanceOf(prover), BOND / 10);
        assertEq(lm.totalSlashedReceived(), BOND - BOND / 10);

        vm.expectRevert(DepositManager.AlreadySlashed.selector);
        dm.proveEquivocation(BASE, vm.addr(pk), 1, a, sa, 0, 2, b, sb, 0);
    }

    function test_equivocation_reverts() public {
        L2Deposit[] memory a = _spokeDeposits(BASE, 2, 100e6);
        L2Deposit[] memory b = _copy(a);
        b[1].ownerDigest = 42;
        uint256 pk = pks[0];
        address signer = vm.addr(pk);
        bytes memory sa = _sig(pk, dm.batchDigest(BASE, 1, a));
        bytes memory sb = _sig(pk, dm.batchDigest(BASE, 1, b));

        vm.expectRevert(abi.encodeWithSelector(IDepositManager.InvalidSigner.selector, address(0xdead)));
        dm.proveEquivocation(BASE, address(0xdead), 1, a, sa, 1, 1, b, sb, 1);
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.UnsupportedChain.selector, uint64(3)));
        dm.proveEquivocation(3, signer, 1, a, sa, 1, 1, b, sb, 1);
        vm.expectRevert(IDepositManager.BatchDataMismatch.selector);
        dm.proveEquivocation(BASE, signer, 1, a, sa, 2, 1, b, sb, 1);
        vm.expectRevert(IDepositManager.NotFraud.selector); // different index
        dm.proveEquivocation(BASE, signer, 1, a, sa, 0, 1, b, sb, 1);
        vm.expectRevert(IDepositManager.NotFraud.selector); // same content
        dm.proveEquivocation(BASE, signer, 1, a, sa, 0, 1, b, sb, 0);
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.BadSignature.selector, signer));
        dm.proveEquivocation(BASE, signer, 2, a, sa, 1, 1, b, sb, 1); // sigA over epoch 1
        bytes memory other = _sig(pks[1], dm.batchDigest(BASE, 1, b));
        vm.expectRevert(abi.encodeWithSelector(IDepositManager.BadSignature.selector, signer));
        dm.proveEquivocation(BASE, signer, 1, a, sa, 1, 1, b, other, 1);
        // valid
        dm.proveEquivocation(BASE, signer, 1, a, sa, 1, 1, b, sb, 1);
    }

    function test_equivocation_submittedBatch_thenMismatch() public {
        // signer 0 signs batch A (fake) that is submitted, and a conflicting B from gossip
        L2Deposit[] memory real = _spokeDeposits(BASE, 1, 100e6);
        L2Deposit[] memory fake = _copy(real);
        fake[0].amount = 5_000e6;
        _attest(BASE, 1, fake, _allPks());
        bytes memory sa = _sig(pks[0], dm.batchDigest(BASE, 1, fake));
        bytes memory sb = _sig(pks[0], dm.batchDigest(BASE, 1, real));
        dm.proveEquivocation(BASE, vm.addr(pks[0]), 1, fake, sa, 0, 1, real, sb, 0);
        // the batch is still pending; the checkpoint slashes the remaining signers
        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Pending));
        _checkpointAll(BASE);
        assertEq(uint8(dm.batchStatus(1)), uint8(IDepositManager.BatchStatus.Fraud));
        assertGe(lm.totalSlashedReceived(), 5_000e6);
    }

    // ================================================================== guardian caps

    function test_setCaps() public {
        vm.expectRevert(IDepositManager.OnlyGuardian.selector);
        dm.setCaps(1_000e6, 1_000e6, 1e12, 1, 2);

        vm.startPrank(guardian);
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        dm.setCaps(MIN_DEP - 1, 1_000e6, 1e12, 1, 2);
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        dm.setCaps(100_000_000e6 + 1, 1_000e6, 1e12, 1, 2);
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        dm.setCaps(1_000e6, MIN_DEP - 1, 1e12, 1, 2);
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        dm.setCaps(1_000e6, 100_000_000e6 + 1, 1e12, 1, 2);
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        dm.setCaps(1_000e6, 1_000e6, 1_000_000_000e6 + 1, 1, 2);
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        dm.setCaps(1_000e6, 1_000e6, 1e12, 1, 0);
        vm.expectRevert(IDepositManager.OutOfBounds.selector);
        dm.setCaps(1_000e6, 1_000e6, 1e12, 3, 2); // β > βmax = 1

        vm.expectEmit(address(dm));
        emit IDepositManager.CapsUpdated(2_000e6, 500e6, 1e12, 1, 1);
        dm.setCaps(2_000e6, 500e6, 1e12, 1, 1);
        vm.stopPrank();
        assertEq(dm.maxDeposit(), 2_000e6);
        assertEq(dm.maxFastDeposit(), 500e6);
        assertEq(dm.tvlCapEth(), 1e12);
        (uint256 n, uint256 d) = dm.beta();
        assertEq(n, 1);
        assertEq(d, 1);

        // renounced guardian: nobody
        hub.setGuardian(address(0));
        vm.prank(guardian);
        vm.expectRevert(IDepositManager.OnlyGuardian.selector);
        dm.setCaps(2_000e6, 500e6, 1e12, 1, 1);
    }

    // ================================================================== views

    function test_digest_matchesIndependentEip712() public view {
        L2Deposit[] memory ds = new L2Deposit[](2);
        ds[0] = L2Deposit(3, 11, 22e6, 100_000, 77);
        ds[1] = L2Deposit(4, 12, 23e6, 100_000, 78);
        bytes32 td = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 ds_ = keccak256(abi.encode(td, keccak256("xpool"), keccak256("1"), block.chainid, address(dm)));
        assertEq(dm.domainSeparator(), ds_);
        bytes32 th = keccak256("L2Deposit(uint64 index,uint256 ownerDigest,uint256 amount,uint256 fee,uint64 l2Block)");
        bytes32 bh = keccak256(
            "DepositBatch(uint64 srcChainId,address spoke,uint64 epoch,L2Deposit[] deposits)L2Deposit(uint64 index,uint256 ownerDigest,uint256 amount,uint256 fee,uint64 l2Block)"
        );
        bytes32 h0 = keccak256(abi.encode(th, uint64(3), uint256(11), uint256(22e6), uint256(100_000), uint64(77)));
        bytes32 h1 = keccak256(abi.encode(th, uint64(4), uint256(12), uint256(23e6), uint256(100_000), uint64(78)));
        bytes32 sh = keccak256(abi.encode(bh, BASE, baseSpoke, uint64(9), keccak256(abi.encodePacked(h0, h1))));
        assertEq(dm.batchDigest(BASE, 9, ds), keccak256(abi.encodePacked("\x19\x01", ds_, sh)));
    }

    function test_views() public view {
        assertEq(dm.spokeOf(BASE), baseSpoke);
        assertEq(dm.spokeOf(ARB), arbSpoke);
        assertEq(dm.spokeOf(1), address(0));
        assertEq(dm.minDeposit(), MIN_DEP);
        assertEq(dm.maxDeposit(), 1_000e6);
        assertEq(dm.maxFastDeposit(), 10_000e6);
    }

    // ================================================================== helpers

    function _expectAttestRevert(uint64 chain, uint64 epoch, L2Deposit[] memory ds, bytes memory err) internal {
        _expectAttestRevertWith(chain, epoch, ds, _allPks(), err);
    }

    function _expectAttestRevertWith(
        uint64 chain,
        uint64 epoch,
        L2Deposit[] memory ds,
        uint256[] memory keys,
        bytes memory err
    ) internal {
        (address[] memory s, bytes[] memory g) = _signAll(chain, epoch, ds, keys);
        vm.expectRevert(err);
        dm.submitAttestation(chain, epoch, ds, s, g);
    }

    function _copy(L2Deposit[] memory a) internal pure returns (L2Deposit[] memory b) {
        b = new L2Deposit[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = L2Deposit(a[i].index, a[i].ownerDigest, a[i].amount, a[i].fee, a[i].l2Block);
        }
    }

    function _copyA(address[] memory a) internal pure returns (address[] memory b) {
        b = new address[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }

    function _copyB(bytes[] memory a) internal pure returns (bytes[] memory b) {
        b = new bytes[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }

    function _pkOf(address signer) internal view returns (uint256) {
        for (uint256 i; i < pks.length; ++i) {
            if (vm.addr(pks[i]) == signer) return pks[i];
        }
        revert("pk");
    }

    function _malleate(bytes memory sig) internal pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        return abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }
}

interface IPoseidonT4Like {
    function hash(uint256[3] memory) external pure returns (uint256);
}
