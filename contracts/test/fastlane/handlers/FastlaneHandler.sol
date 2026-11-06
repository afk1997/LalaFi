// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../../../src/mocks/MockUSDC.sol";
import {DepositManager} from "../../../src/hub/DepositManager.sol";
import {StakeManager} from "../../../src/hub/StakeManager.sol";
import {IDepositManager} from "../../../src/interfaces/IDepositManager.sol";
import {L2Deposit, Checkpoint, P} from "../../../src/libraries/Types.sol";
import {MockLiquidityManager, MockHubAdapter} from "../mocks/FastlaneMocks.sol";

/// @notice Random honest + colluding behaviour against DepositManager / StakeManager with a
///         canonical spoke model per chain. Every fake item it gets inserted is tracked in
///         `ghostFakeValue` (value inserted into the tree that no canonical deposit backs).
contract FastlaneHandler is Test {
    uint64 public constant BASE = 8453;
    uint64 public constant ARB = 42161;
    uint64 internal constant EPOCH = 120;
    uint256 internal constant MAX_VALS = 24;

    DepositManager public dm;
    StakeManager public sm;
    MockUSDC public usdc;
    MockLiquidityManager public lm;
    MockHubAdapter public baseAdapter;
    MockHubAdapter public arbAdapter;

    uint256[] public pks;
    address[] public operators;

    struct SpokeModel {
        L2Deposit[] deps;
        uint64 nextFrom;
        uint64 seq;
        uint64 l2Block;
        uint64[] open; // received, not fully processed seqs
    }

    mapping(uint64 => SpokeModel) internal spokes;
    mapping(uint64 => mapping(uint64 => bytes)) public payloads;

    struct FakeBatch {
        uint256 id;
        uint64 chain;
        bytes deps; // abi.encode(L2Deposit[])
    }

    FakeBatch[] internal fakes;
    uint256 public ghostFakeValue;
    uint256 internal salt;

    mapping(bytes32 => uint256) public calls;

    constructor(
        DepositManager dm_,
        StakeManager sm_,
        MockUSDC usdc_,
        MockLiquidityManager lm_,
        MockHubAdapter baseAdapter_,
        MockHubAdapter arbAdapter_
    ) {
        dm = dm_;
        sm = sm_;
        usdc = usdc_;
        lm = lm_;
        baseAdapter = baseAdapter_;
        arbAdapter = arbAdapter_;
    }

    // ================================================================== setup helpers

    function addValidator(uint256 bondAmt, uint256 baseAlloc, uint256 arbAlloc) public {
        if (pks.length >= MAX_VALS) return;
        uint256 n = pks.length;
        uint256 pk = 0xB0B0 + n;
        address op = address(uint160(uint256(keccak256(abi.encode("hop", n)))));
        usdc.mint(op, bondAmt);
        vm.startPrank(op);
        sm.register(vm.addr(pk));
        usdc.approve(address(sm), type(uint256).max);
        sm.bond(bondAmt);
        _alloc(baseAlloc, arbAlloc);
        vm.stopPrank();
        pks.push(pk);
        operators.push(op);
    }

    function _alloc(uint256 b, uint256 a) internal {
        uint64[] memory cs = new uint64[](2);
        cs[0] = BASE;
        cs[1] = ARB;
        uint256[] memory as_ = new uint256[](2);
        as_[0] = b;
        as_[1] = a;
        sm.setAllocations(cs, as_);
    }

    // ================================================================== actions

    function deposit(uint8 chainSeed, uint256 amtSeed) external {
        uint64 c = _chain(chainSeed);
        _spokeDeposit(c, bound(amtSeed, 1e6, 3_000e6));
        calls["deposit"]++;
    }

    function attestHonest(uint8 chainSeed, uint8 nSeed, uint256 maskSeed, bool prevEpoch) external {
        uint64 c = _chain(chainSeed);
        SpokeModel storage s = spokes[c];
        uint256 want = bound(nSeed, 1, 8);
        L2Deposit[] memory ds = new L2Deposit[](want);
        uint256 m;
        for (uint256 i; i < s.deps.length && m < want; ++i) {
            L2Deposit memory d = s.deps[i];
            if (!dm.inserted(c, d.index) && d.amount <= dm.maxFastDeposit()) ds[m++] = d;
        }
        if (m == 0) return;
        assembly ("memory-safe") {
            mstore(ds, m)
        }
        if (_submit(c, _epoch(prevEpoch), ds, maskSeed) != 0) calls["attestHonest.ok"]++;
        calls["attestHonest"]++;
    }

    /// kind 0: inflated amount of an existing deposit; 1: non-existent future index;
    /// 2: same amount, redirected owner. Optionally mixed with honest items.
    function attestFake(uint8 chainSeed, uint8 kind, uint256 amtSeed, uint256 maskSeed, bool withHonest, bool prev)
        external
    {
        uint64 c = _chain(chainSeed);
        SpokeModel storage s = spokes[c];
        L2Deposit[] memory ds = new L2Deposit[](2);
        uint256 m;
        if (withHonest) {
            for (uint256 i; i < s.deps.length; ++i) {
                L2Deposit memory d = s.deps[i];
                if (!dm.inserted(c, d.index)) {
                    ds[m++] = d;
                    break;
                }
            }
        }
        L2Deposit memory f;
        kind = kind % 3;
        uint256 fakeAmt = bound(amtSeed, 1e6, 3_000e6);
        if (kind == 1) {
            uint64 idx = uint64(s.deps.length + bound(amtSeed >> 128, 0, 20));
            f = L2Deposit(idx, _digest(), fakeAmt, 0, s.l2Block);
        } else {
            bool found;
            for (uint256 i = s.deps.length; i > 0; --i) {
                L2Deposit memory d = s.deps[i - 1];
                if (!dm.inserted(c, d.index) && (m == 0 || d.index != ds[0].index)) {
                    if (kind == 0) {
                        if (fakeAmt == d.amount) fakeAmt += 1;
                        f = L2Deposit(d.index, d.ownerDigest, fakeAmt, d.fee, d.l2Block);
                    } else {
                        fakeAmt = d.amount;
                        f = L2Deposit(d.index, _digest(), d.amount, d.fee, d.l2Block);
                    }
                    found = true;
                    break;
                }
            }
            if (!found) return;
        }
        if (dm.inserted(c, f.index)) return;
        ds[m++] = f;
        assembly ("memory-safe") {
            mstore(ds, m)
        }
        uint256 id = _submit(c, _epoch(prev), ds, maskSeed);
        if (id != 0) {
            ghostFakeValue += fakeAmt;
            fakes.push(FakeBatch(id, c, abi.encode(ds)));
            calls["attestFake.ok"]++;
        }
        calls["attestFake"]++;
    }

    function sendCheckpoint(uint8 chainSeed, uint8 maxSeed) external {
        uint64 c = _chain(chainSeed);
        _sendCheckpoint(c, bound(maxSeed, 1, 16));
        calls["sendCheckpoint"]++;
    }

    function processSome(uint8 chainSeed, uint8 chunkSeed, bool newest) external {
        uint64 c = _chain(chainSeed);
        SpokeModel storage s = spokes[c];
        if (s.open.length == 0) return;
        uint256 pos = newest ? s.open.length - 1 : 0;
        uint64 seq = s.open[pos];
        address proc = address(uint160(0xC0DE00 + (chunkSeed % 3)));
        vm.prank(proc);
        dm.processCheckpoint(c, seq, payloads[c][seq], bound(chunkSeed, 0, 8));
        if (dm.checkpointOf(c, seq).nextItem == dm.checkpointOf(c, seq).to) {
            s.open[pos] = s.open[s.open.length - 1];
            s.open.pop();
        }
        calls["processSome"]++;
    }

    function proveAbsences() external {
        _proveAbsences(BASE);
        _proveAbsences(ARB);
        calls["proveAbsences"]++;
    }

    function equivocate(uint8 vSeed, uint8 chainSeed) external {
        if (pks.length == 0 || chainSeed % 8 > 1) return; // rare: keeps the validator set alive
        uint256 i = vSeed % pks.length;
        (,, bool jailed) = sm.validatorBySigner(vm.addr(pks[i]));
        if (jailed) return;
        uint64 c = _chain(chainSeed);
        L2Deposit[] memory a = new L2Deposit[](1);
        L2Deposit[] memory b = new L2Deposit[](1);
        a[0] = L2Deposit(uint64(1000 + vSeed), 1, 5e6, 0, 1);
        b[0] = L2Deposit(uint64(1000 + vSeed), 2, 5e6, 0, 1);
        bytes memory sa = _sign(pks[i], dm.batchDigest(c, 1, a));
        bytes memory sb = _sign(pks[i], dm.batchDigest(c, 2, b));
        dm.proveEquivocation(c, vm.addr(pks[i]), 1, a, sa, 0, 2, b, sb, 0);
        calls["equivocate"]++;
    }

    function newValidator(uint256 bondSeed, uint256 split) external {
        uint256 b = bound(bondSeed, 200e6, 20_000e6);
        uint256 x = bound(split, 0, b);
        addValidator(b, x, b - x);
        calls["newValidator"]++;
    }

    function advance(uint256 extra) external {
        vm.warp(block.timestamp + EPOCH + bound(extra, 0, 600));
        sm.advanceEpoch();
        calls["advance"]++;
    }

    function unbond(uint8 vSeed, uint256 amtSeed) external {
        if (pks.length == 0) return;
        uint256 i = vSeed % pks.length;
        uint32 id = sm.idByOperator(operators[i]);
        uint256 bonded = sm.bondedOf(id);
        if (bonded == 0) return;
        vm.prank(operators[i]);
        sm.requestUnbond(bound(amtSeed, 1, bonded));
        calls["unbond"]++;
    }

    function withdraw(uint8 vSeed, uint256 warpSeed) external {
        if (pks.length == 0) return;
        vm.warp(block.timestamp + bound(warpSeed, 0, 1_000));
        uint256 i = vSeed % pks.length;
        vm.prank(operators[i]);
        sm.withdrawUnbonded();
        calls["withdraw.ok"]++;
    }

    function realloc(uint8 vSeed, uint256 a, uint256 b) external {
        if (pks.length == 0) return;
        uint256 i = vSeed % pks.length;
        uint256 bonded = sm.bondedOf(sm.idByOperator(operators[i]));
        a = bound(a, 0, bonded);
        b = bound(b, 0, bonded - a);
        vm.prank(operators[i]);
        _alloc(a, b);
        calls["realloc"]++;
    }

    function bondMore(uint8 vSeed, uint256 amt) external {
        if (pks.length == 0) return;
        uint256 i = vSeed % pks.length;
        amt = bound(amt, 1, 5_000e6);
        usdc.mint(operators[i], amt);
        vm.prank(operators[i]);
        sm.bond(amt);
        calls["bondMore"]++;
    }

    function setBuffers(uint256 lp) external {
        lm.setLpAssets(bound(lp, 10_000e6, 1_000_000e6));
        calls["setBuffers"]++;
    }

    // ================================================================== settlement (all proofs)

    /// @notice Delivers and processes every canonical checkpoint, then proves absence for every
    ///         fake batch still pending. After this, every fraudulent batch must be Fraud.
    function settleAll() external {
        uint64[2] memory cs = [BASE, ARB];
        for (uint256 k; k < 2; ++k) {
            uint64 c = cs[k];
            SpokeModel storage s = spokes[c];
            while (s.nextFrom < s.deps.length) {
                _sendCheckpoint(c, 64);
            }
            _sendCheckpoint(c, 64); // final (empty) checkpoint at a later l2 block
            for (uint256 j; j < s.open.length; ++j) {
                uint64 seq = s.open[j];
                if (dm.checkpointOf(c, seq).nextItem < dm.checkpointOf(c, seq).to) {
                    dm.processCheckpoint(c, seq, payloads[c][seq], 0);
                }
            }
            delete s.open;
            _proveAbsences(c);
        }
    }

    // ================================================================== views for invariants

    function fakeCount() external view returns (uint256) {
        return fakes.length;
    }

    function fakeBatchId(uint256 i) external view returns (uint256) {
        return fakes[i].id;
    }

    function validatorCount() external view returns (uint256) {
        return pks.length;
    }

    /// Σ (a + fee) over canonical deposits the DepositManager marked confirmed, and the fees.
    function canonicalConfirmed(uint64 c) external view returns (uint256 sum, uint256 fees, uint256 bad) {
        SpokeModel storage s = spokes[c];
        for (uint256 i; i < s.deps.length; ++i) {
            if (dm.confirmed(c, s.deps[i].index)) {
                sum += s.deps[i].amount + s.deps[i].fee;
                fees += s.deps[i].fee;
                if (!dm.inserted(c, s.deps[i].index)) bad++;
            }
        }
        // nothing beyond the canonical count may be confirmed
        for (uint256 i = s.deps.length; i < s.deps.length + 25; ++i) {
            if (dm.confirmed(c, uint64(i))) bad++;
        }
    }

    // ================================================================== internals

    function _chain(uint8 seed) internal pure returns (uint64) {
        return seed % 2 == 0 ? BASE : ARB;
    }

    function _epoch(bool prev) internal view returns (uint64) {
        uint64 cur = sm.currentEpoch();
        return prev && cur > 0 ? cur - 1 : cur;
    }

    function _digest() internal returns (uint256) {
        return uint256(keccak256(abi.encode("hd", ++salt))) % P;
    }

    function _spokeDeposit(uint64 c, uint256 amount) internal {
        SpokeModel storage s = spokes[c];
        s.l2Block += 1;
        s.deps.push(L2Deposit(uint64(s.deps.length), _digest(), amount, c == BASE ? 100_000 : 0, s.l2Block));
    }

    function _sendCheckpoint(uint64 c, uint256 maxItems) internal {
        SpokeModel storage s = spokes[c];
        s.l2Block += 1;
        uint64 from = s.nextFrom;
        uint64 count = uint64(s.deps.length);
        uint64 to = count - from > maxItems ? from + uint64(maxItems) : count;
        L2Deposit[] memory ds = new L2Deposit[](to - from);
        for (uint64 i = from; i < to; ++i) {
            ds[i - from] = s.deps[i];
        }
        uint64 seq = s.seq++;
        s.nextFrom = to;
        bytes memory body = abi.encode(
            Checkpoint({seq: seq, from: from, to: to, countAtSend: count, l2Block: s.l2Block, deposits: ds})
        );
        payloads[c][seq] = body;
        (c == BASE ? baseAdapter : arbAdapter).deliver(body);
        if (to > from) s.open.push(seq);
    }

    function _proveAbsences(uint64 c) internal {
        SpokeModel storage s = spokes[c];
        if (s.seq == 0) return;
        uint64 seq = s.seq - 1; // latest checkpoint
        for (uint256 i; i < fakes.length; ++i) {
            FakeBatch storage fb = fakes[i];
            if (fb.chain != c || dm.batchStatus(fb.id) != IDepositManager.BatchStatus.Pending) continue;
            L2Deposit[] memory ds = abi.decode(fb.deps, (L2Deposit[]));
            for (uint256 p; p < ds.length; ++p) {
                try dm.proveAbsence(c, seq, fb.id, ds, p) {
                    break;
                } catch {}
            }
        }
    }

    /// @dev 3/4 of the time the full set signs (full collusion or honest supermajority), else a random subset.
    function _mask(uint256 seed, uint256 n) internal pure returns (uint256 mask) {
        if (seed == 0) return (1 << n) - 1;
        uint256 r = uint256(keccak256(abi.encode(seed)));
        mask = r % (1 << n);
        if (mask == 0 || (r >> 128) % 4 != 0) mask = (1 << n) - 1;
    }

    /// @dev A node only signs where it has stake (it knows its own allocation).
    function _canSign(uint256 pk, uint64 c, uint64 epoch) internal view returns (bool) {
        (uint32 id,, bool jailed) = sm.validatorBySigner(vm.addr(pk));
        return !jailed && sm.allocation(id, c, epoch) != 0 && sm.allocation(id, c, sm.currentEpoch()) != 0;
    }

    function _submit(uint64 c, uint64 epoch, L2Deposit[] memory ds, uint256 maskSeed) internal returns (uint256) {
        uint256 n = pks.length;
        if (n == 0) return 0;
        uint256 mask = _mask(maskSeed, n);
        // collect signer keys sorted by address
        uint256[] memory keys = new uint256[](n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            if (mask & (1 << i) == 0 || !_canSign(pks[i], c, epoch)) continue;
            keys[m++] = pks[i];
        }
        if (m == 0) return 0;
        for (uint256 i = 1; i < m; ++i) {
            uint256 key = keys[i];
            uint256 j = i;
            while (j > 0 && vm.addr(keys[j - 1]) > vm.addr(key)) {
                keys[j] = keys[j - 1];
                --j;
            }
            keys[j] = key;
        }
        bytes32 digest = dm.batchDigest(c, epoch, ds);
        address[] memory signers = new address[](m);
        bytes[] memory sigs = new bytes[](m);
        for (uint256 i; i < m; ++i) {
            signers[i] = vm.addr(keys[i]);
            sigs[i] = _sign(keys[i], digest);
        }
        vm.prank(address(0x5AB));
        try dm.submitAttestation(c, epoch, ds, signers, sigs) returns (uint256 id) {
            return id;
        } catch {
            return 0;
        }
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
