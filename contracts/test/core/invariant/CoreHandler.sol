// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {HubCore} from "../../../src/hub/HubCore.sol";
import {LiquidityManager} from "../../../src/hub/LiquidityManager.sol";
import {MockUSDC} from "../../../src/mocks/MockUSDC.sol";
import {ZeroHashes} from "../../../src/libraries/ZeroHashes.sol";
import {
    P,
    EXT_DATA_VERSION,
    Proof,
    PublicInputs,
    ExtData,
    Release,
    BridgeParams
} from "../../../src/libraries/Types.sol";
import {
    CoreMockDepositManager,
    CoreMockStakeManager,
    CoreMockAdapter,
    CoreMockTokenMessenger
} from "../mocks/CoreMocks.sol";
import {RefMerkle} from "../utils/RefMerkle.sol";

/// @notice Drives HubCore + LiquidityManager through every user, keeper and guardian action and
///         keeps ghost state for I1, I2, I3 (LiquidityManager part), I7, I9 and I11.
///
///         Model of the outside world:
///         - L2 deposits are canonically confirmed at once (credit(c, a + fee), fee as bounty).
///         - Spokes execute releases as soon as they're sent (the mock adapter records them,
///           idempotently per index); ghostSpokeVault[c] is the spoke's USDC balance.
///         - CCTP burns sit in ghostInflight[c] until completeMint() lands them.
contract CoreHandler is Test {
    HubCore public hub;
    LiquidityManager public lm;
    MockUSDC public usdc;
    CoreMockDepositManager public dm;
    CoreMockStakeManager public sm;
    CoreMockAdapter public baseAdapter;
    CoreMockAdapter public arbAdapter;
    CoreMockTokenMessenger public tm;
    RefMerkle public ref;
    address public guardian;

    uint64 public immutable ETH;
    uint64 public immutable BASE;
    uint64 public immutable ARB;
    uint256 internal constant BUCKET = 10_000;
    uint256 internal constant MIN_W = 1e6;

    address[3] internal lps;
    address[3] internal relayers; // relayers[2] is blacklisted by USDC
    address internal hunter = address(0xB0B7);

    // ---- ghosts
    uint256 public ghostDeposited; // Σ inserted deposit amounts
    uint256 public ghostSpentV; // Σ v over accepted spends
    mapping(uint256 => uint256) public nullifierAccepts;
    uint256[] internal _spentNullifiers;
    bool public doubleAccept; // I1 violation
    uint256 public reuseAttempts;
    uint256 public reuseRejected;
    mapping(uint64 => uint256) public ghostSpokeVault;
    mapping(uint64 => uint256) public ghostInflight; // CCTP mints in flight towards c (ETH = LM)
    // Spoke queue (Q_c): releases and rebalance burns reserved on the hub but not yet executed
    // because the spoke vault is waiting for an in-flight CCTP mint.
    mapping(uint64 => uint256) public queuedReleases;

    struct PendingBurn {
        uint64 dst;
        uint256 amount;
    }
    mapping(uint64 => PendingBurn[]) internal _queuedBurns;
    mapping(uint64 => uint256) public queuedBurnTotal; // queued burns out of c
    mapping(uint64 => uint256) public queuedBurnTo; // queued burns (at any source) towards c
    bool public guardianReducedBalance; // I9 violation
    bool public pauseTooOften; // I9 violation
    uint256 public lastPauseStart;
    uint256 public pauses;
    uint256 internal _nonce = 1;

    mapping(bytes32 => uint256) public calls;

    constructor(
        HubCore hub_,
        LiquidityManager lm_,
        MockUSDC usdc_,
        CoreMockDepositManager dm_,
        CoreMockStakeManager sm_,
        CoreMockAdapter baseAdapter_,
        CoreMockAdapter arbAdapter_,
        CoreMockTokenMessenger tm_,
        RefMerkle ref_,
        address guardian_
    ) {
        hub = hub_;
        lm = lm_;
        usdc = usdc_;
        dm = dm_;
        sm = sm_;
        baseAdapter = baseAdapter_;
        arbAdapter = arbAdapter_;
        tm = tm_;
        ref = ref_;
        guardian = guardian_;
        ETH = uint64(block.chainid);
        BASE = hub_.baseChainId();
        ARB = hub_.arbChainId();
        for (uint256 i; i < 3; ++i) {
            lps[i] = address(uint160(0x1000 + i));
            relayers[i] = address(uint160(0x2000 + i));
        }
    }

    function blacklistedRelayer() external view returns (address) {
        return relayers[2];
    }

    function spentNullifierCount() external view returns (uint256) {
        return _spentNullifiers.length;
    }

    function spentNullifier(uint256 i) external view returns (uint256) {
        return _spentNullifiers[i];
    }

    function _rand(string memory tag) internal returns (uint256) {
        return uint256(keccak256(abi.encode(tag, _nonce++))) % P;
    }

    function _chain(uint256 s) internal view returns (uint64) {
        s %= 3;
        return s == 0 ? ETH : (s == 1 ? BASE : ARB);
    }

    // ================================================================== deposits

    function depositEth(uint256 amount, bool two) external {
        calls["depositEth"]++;
        amount = _bound(amount, 1e6, 1e12);
        uint256[] memory cs = new uint256[](two ? 2 : 1);
        cs[0] = _rand("c");
        if (two) cs[1] = _rand("c");
        usdc.mint(address(lm), amount);
        dm.insert(cs, amount);
        dm.credit(ETH, amount);
        ghostDeposited += amount;
        ref.insertPair(cs[0], two ? cs[1] : ZeroHashes.Z0);
    }

    function depositL2(uint256 chainSeed, uint256 amount, uint256 fee) external {
        calls["depositL2"]++;
        uint64 c = chainSeed % 2 == 0 ? BASE : ARB;
        amount = _bound(amount, 1e6, 1e12);
        fee = _bound(fee, 0, 1e6);
        uint256[] memory cs = new uint256[](1);
        cs[0] = _rand("c");
        ghostSpokeVault[c] += amount + fee; // spoke pulled amount + settleFee
        dm.insert(cs, amount);
        dm.credit(c, amount + fee);
        if (fee > 0) dm.creditBounty(hunter, fee);
        ghostDeposited += amount;
        ref.insertPair(cs[0], ZeroHashes.Z0);
    }

    // ================================================================== spends

    struct TxVars {
        uint64 dst;
        uint256 w;
        uint256 relFee;
        uint256 protoFee;
        uint256 v;
        address recipient;
        address relayer;
        bool reuse;
    }

    function transact(uint256 seed, uint256 dstSeed, uint256 wSeed, uint256 feeSeed, uint256 rootSeed) external {
        calls["transact"]++;
        TxVars memory t;
        uint256 supply = hub.shieldedSupply();
        t.dst = dstSeed % 4 == 0 ? 0 : _chain(dstSeed);
        t.relFee = _bound(feeSeed, 0, 20) * BUCKET;
        t.relayer = relayers[seed % 3];
        if (t.dst != 0) {
            uint256 lmax = lm.available(t.dst);
            // leave room for the fees
            uint256 cap = supply > t.relFee ? (supply - t.relFee) * 1000 / 1001 : 0;
            if (cap > lmax) cap = lmax;
            if (cap < MIN_W) {
                t.dst = 0;
            } else {
                t.w = _bound(wSeed, MIN_W, cap);
                t.protoFee = Math.mulDiv(t.w, hub.phiBps(), 10_000, Math.Rounding.Ceil);
                t.recipient = address(uint160(0x3000 + (seed % 5)));
            }
        }
        t.v = t.w + t.relFee + t.protoFee;
        if (t.v > supply) {
            t.relFee = 0;
            t.v = t.w + t.protoFee;
            if (t.v > supply) return;
        }

        ExtData memory e = ExtData({
            version: EXT_DATA_VERSION,
            hubChainId: ETH,
            hub: address(hub),
            dstChainId: t.dst,
            recipient: t.recipient,
            withdrawAmount: t.w,
            relayer: t.relayer,
            relayerFee: t.relFee,
            protocolFee: t.protoFee,
            deadline: uint64(block.timestamp + 1 hours),
            encOut0: hex"01",
            encOut1: hex"02"
        });

        PublicInputs memory pi;
        // root: any of the last 100 reference roots
        uint256 rc = ref.rootCount();
        uint256 back = _bound(rootSeed, 0, rc - 1 < 99 ? rc - 1 : 99);
        pi.root = ref.roots(rc - 1 - back);
        pi.publicAmount = t.v == 0 ? 0 : P - t.v;
        pi.extDataHash = uint256(keccak256(abi.encode(e))) % P;
        t.reuse = seed % 7 == 0 && _spentNullifiers.length > 0;
        pi.inputNullifiers[0] = t.reuse ? _spentNullifiers[seed % _spentNullifiers.length] : _rand("n");
        pi.inputNullifiers[1] = _rand("n");
        pi.outputCommitments = [_rand("c"), _rand("c")];
        if (t.reuse) reuseAttempts++;

        Proof memory proof;
        BridgeParams memory bp;
        uint256 before0 = nullifierAccepts[pi.inputNullifiers[0]];
        uint256 before1 = nullifierAccepts[pi.inputNullifiers[1]];
        try hub.transact(proof, pi, e, bp) {
            calls["transact.ok"]++;
            if (before0 > 0 || before1 > 0) doubleAccept = true;
            nullifierAccepts[pi.inputNullifiers[0]]++;
            nullifierAccepts[pi.inputNullifiers[1]]++;
            _spentNullifiers.push(pi.inputNullifiers[0]);
            _spentNullifiers.push(pi.inputNullifiers[1]);
            ghostSpentV += t.v;
            ref.insertPair(pi.outputCommitments[0], pi.outputCommitments[1]);
            if (t.dst == BASE || t.dst == ARB) {
                queuedReleases[t.dst] += t.w;
                _settleSpoke(t.dst);
            }
        } catch {
            if (t.reuse) reuseRejected++;
        }
    }

    function resendRelease(uint256 dstSeed, uint256 idxSeed) external {
        calls["resend"]++;
        uint64 dst = dstSeed % 2 == 0 ? BASE : ARB;
        uint64 n = hub.releaseCount(dst);
        if (n == 0) return;
        uint64 idx = uint64(idxSeed % n);
        CoreMockAdapter a = dst == BASE ? baseAdapter : arbAdapter;
        Release memory r = a.releaseAt(idx);
        BridgeParams memory bp;
        hub.resendRelease(r, bp);
    }

    // ================================================================== LPs / balances

    function addLiquidity(uint256 who, uint256 amount) external {
        calls["addLiquidity"]++;
        if (hub.inflowsPaused()) return;
        address lp = lps[who % 3];
        amount = _bound(amount, 1, 1e12);
        if (lm.previewAdd(amount) == 0) return;
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(address(lm), amount);
        lm.addLiquidity(amount, lp);
        vm.stopPrank();
    }

    function removeLiquidity(uint256 who, uint256 frac) external {
        calls["removeLiquidity"]++;
        address lp = lps[who % 3];
        uint256 bal = lm.balanceOf(lp);
        if (bal == 0) return;
        uint256 shares = bal * _bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        vm.prank(lp);
        try lm.removeLiquidity(shares, lp) {
            calls["removeLiquidity.ok"]++;
        } catch {}
    }

    function claim(uint256 who) external {
        calls["claim"]++;
        address a = who % 4 == 3 ? hunter : relayers[who % 3];
        vm.prank(a);
        try lm.claim() {
            calls["claim.ok"]++;
        } catch {}
    }

    function slash(uint256 amount) external {
        calls["slash"]++;
        sm.slashIn(_bound(amount, 1, 1e10));
    }

    function takeRewardPot() external {
        calls["takeRewardPot"]++;
        sm.take();
    }

    function setUfv(uint256 v) external {
        calls["setUfv"]++;
        dm.setUnconfirmedFastValue(_bound(v, 0, 1e12));
    }

    // ================================================================== rebalancing

    function rebalance(uint256 srcSeed, uint256 dstSeed, uint256 mSeed) external {
        calls["rebalance"]++;
        uint64 src = _chain(srcSeed);
        uint64 dst = _chain(dstSeed);
        if (src == dst) return;
        uint256 total = lm.totalLiquidity();
        uint256 tSrc = Math.mulDiv(lm.targetBps(src), total, 10_000, Math.Rounding.Ceil);
        uint256 tDst = lm.target(dst);
        uint256 lSrc = lm.available(src);
        uint256 lDst = lm.available(dst);
        if (lSrc <= tSrc || lDst >= tDst) return;
        uint256 m = lSrc - tSrc;
        if (tDst - lDst < m) m = tDst - lDst;
        if (m < lm.minRebalance()) return;
        m = _bound(mSeed, lm.minRebalance(), m);
        BridgeParams memory bp;
        lm.rebalance(src, dst, m, bp);
        calls["rebalance.ok"]++;
        if (src == ETH) {
            ghostInflight[dst] += m;
        } else {
            _queuedBurns[src].push(PendingBurn(dst, m));
            queuedBurnTotal[src] += m;
            queuedBurnTo[dst] += m;
            _settleSpoke(src);
        }
    }

    /// @dev Spoke processQueue: pays queued releases, then executes queued burns, while funds last.
    function _settleSpoke(uint64 c) internal {
        uint256 v = ghostSpokeVault[c];
        uint256 pay = queuedReleases[c] < v ? queuedReleases[c] : v;
        queuedReleases[c] -= pay;
        v -= pay;
        PendingBurn[] storage q = _queuedBurns[c];
        while (q.length > 0 && q[q.length - 1].amount <= v) {
            PendingBurn memory b = q[q.length - 1];
            q.pop();
            v -= b.amount;
            queuedBurnTotal[c] -= b.amount;
            queuedBurnTo[b.dst] -= b.amount;
            ghostInflight[b.dst] += b.amount;
        }
        ghostSpokeVault[c] = v;
    }

    function completeMint(uint256 chainSeed) external {
        calls["completeMint"]++;
        uint64 c = _chain(chainSeed);
        uint256 m = ghostInflight[c];
        if (m == 0) return;
        ghostInflight[c] = 0;
        if (c == ETH) {
            usdc.mint(address(lm), m);
        } else {
            ghostSpokeVault[c] += m;
            _settleSpoke(c);
        }
    }

    // ================================================================== guardian / time

    function guardianAct(uint256 kind, uint256 a, uint256 b) external {
        calls["guardian"]++;
        uint256 balBefore = usdc.balanceOf(address(lm));
        uint256 lBefore = lm.totalLiquidity();
        BridgeParams memory bp;
        vm.startPrank(guardian);
        kind %= 6;
        if (kind == 0) {
            try hub.setInflowsPaused(a % 2 == 0) {} catch {}
        } else if (kind == 1) {
            try hub.pauseSpokeDeposits(a % 2 == 0 ? BASE : ARB, b % 2 == 0, bp) {} catch {}
        } else if (kind == 2) {
            try hub.emergencyPauseSpends() {
                if (pauses > 0 && block.timestamp < lastPauseStart + 30 days) pauseTooOften = true;
                lastPauseStart = block.timestamp;
                pauses++;
            } catch {}
        } else if (kind == 3 || kind == 4) {
            uint256 e = _bound(a, 500, 6500);
            uint256 bb = _bound(b, 500, 6500);
            uint256 ar = e + bb <= 10_000 ? 10_000 - e - bb : 0;
            try lm.setTargets(e, bb, ar) {} catch {}
        } else if (a % 64 == 0) {
            try hub.renounceGuardian() {} catch {}
        }
        // The guardian also tries the restricted money paths directly; all must fail.
        try lm.payOnL1(guardian, 1) {} catch {}
        try lm.reserve(ETH, 1) {} catch {}
        try lm.takeRewardPot() {} catch {}
        vm.stopPrank();
        if (usdc.balanceOf(address(lm)) < balBefore || lm.totalLiquidity() < lBefore) {
            guardianReducedBalance = true;
        }
    }

    function warp(uint256 dt) external {
        calls["warp"]++;
        vm.warp(block.timestamp + _bound(dt, 0, 5 days));
    }
}
