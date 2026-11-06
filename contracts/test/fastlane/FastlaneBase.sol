// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
// forces compilation of the poseidon-solidity artifact used by deployCode
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";

import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {DepositManager} from "../../src/hub/DepositManager.sol";
import {StakeManager} from "../../src/hub/StakeManager.sol";
import {IPoseidonT4} from "../../src/interfaces/IPoseidon.sol";
import {DepositManagerConfig, StakeManagerConfig} from "../../src/libraries/DeployConfig.sol";
import {L2Deposit, Checkpoint, P} from "../../src/libraries/Types.sol";
import {MockHubCore, MockLiquidityManager, MockHubAdapter} from "./mocks/FastlaneMocks.sol";

abstract contract FastlaneBase is Test {
    uint64 internal constant BASE = 8453;
    uint64 internal constant ARB = 42161;

    uint256 internal constant SMIN = 100e6;
    uint64 internal constant EPOCH = 120;
    uint64 internal constant UNBOND = 600;
    uint256 internal constant MIN_DEP = 1e6;
    uint256 internal constant BASE_INS = 75_000;
    uint256 internal constant BASE_FIN = 25_000;

    MockUSDC internal usdc;
    MockHubCore internal hub;
    MockLiquidityManager internal lm;
    MockHubAdapter internal baseAdapter;
    MockHubAdapter internal arbAdapter;
    StakeManager internal sm;
    DepositManager internal dm;
    address internal poseidon;

    address internal baseSpoke = address(0xBA5E);
    address internal arbSpoke = address(0xA4B1);
    address internal guardian = makeAddr("guardian");
    address internal submitter = makeAddr("submitter");
    address internal processor = makeAddr("processor");

    // validators
    uint256[] internal pks;
    address[] internal operators;
    uint32[] internal vids;

    // canonical spoke model
    struct SpokeModel {
        L2Deposit[] deps;
        uint64 nextFrom;
        uint64 seq;
        uint64 l2Block;
    }

    mapping(uint64 => SpokeModel) internal spokes;
    mapping(uint64 => mapping(uint64 => bytes)) internal payloads; // chain => seq => body

    uint256 private _nonceDigest;

    function setUp() public virtual {
        _deployAll();
    }

    // ------------------------------------------------------------------ deployment

    function _smConfig() internal view virtual returns (StakeManagerConfig memory c) {
        c.usdc = address(usdc);
        c.liquidityManager = address(lm);
        c.baseChainId = BASE;
        c.arbChainId = ARB;
        c.sMin = SMIN;
        c.kNum = 3;
        c.kDen = 2;
        c.thetaNum = 2;
        c.thetaDen = 3;
        c.omegaBps = 1000;
        c.evictionMarginBps = 100;
        c.epochSeconds = EPOCH;
        c.unbondSeconds = UNBOND;
    }

    function _dmConfig() internal view virtual returns (DepositManagerConfig memory c) {
        c.hub = address(hub);
        c.liquidityManager = address(lm);
        c.poseidonT4 = poseidon;
        c.usdc = address(usdc);
        c.baseChainId = BASE;
        c.baseAdapter = address(baseAdapter);
        c.baseSpoke = baseSpoke;
        c.arbChainId = ARB;
        c.arbAdapter = address(arbAdapter);
        c.arbSpoke = arbSpoke;
        c.baseSettleInsert = BASE_INS;
        c.baseSettleFinal = BASE_FIN;
        c.arbSettleInsert = 0;
        c.arbSettleFinal = 0;
        c.minDeposit = MIN_DEP;
        c.maxDeposit = 1_000e6;
        c.maxFastDeposit = 10_000e6;
        c.tvlCapEth = 100_000_000e6;
        c.betaNum = 1;
        c.betaDen = 2;
        c.maxDepositHardMax = 100_000_000e6;
        c.maxFastDepositHardMax = 100_000_000e6;
        c.tvlCapHardMax = 1_000_000_000e6;
        c.betaMaxNum = 1;
        c.betaMaxDen = 1;
    }

    function _deployAll() internal {
        usdc = new MockUSDC();
        poseidon = deployCode("PoseidonT4.sol:PoseidonT4");
        hub = new MockHubCore(guardian);
        lm = new MockLiquidityManager(address(usdc));
        baseAdapter = new MockHubAdapter(BASE);
        arbAdapter = new MockHubAdapter(ARB);

        uint64 nonce = vm.getNonce(address(this));
        address smAddr = vm.computeCreateAddress(address(this), nonce);
        address dmAddr = vm.computeCreateAddress(address(this), nonce + 1);

        StakeManagerConfig memory sc = _smConfig();
        sc.depositManager = dmAddr;
        sm = new StakeManager(sc);
        DepositManagerConfig memory dc = _dmConfig();
        dc.stakeManager = smAddr;
        dm = new DepositManager(dc);
        assertEq(address(sm), smAddr);
        assertEq(address(dm), dmAddr);

        hub.setDepositManager(dmAddr);
        lm.setManagers(dmAddr, smAddr);
        baseAdapter.setDepositManager(dmAddr);
        arbAdapter.setDepositManager(dmAddr);
        lm.setLpAssets(1_000_000_000e6); // valve not binding by default
    }

    // ------------------------------------------------------------------ validators

    function _addValidator(uint256 bondAmt, uint256 baseAlloc, uint256 arbAlloc)
        internal
        returns (uint32 id, uint256 pk)
    {
        uint256 n = pks.length;
        pk = 0xA11CE + n;
        address op = makeAddr(string.concat("operator", vm.toString(n)));
        usdc.mint(op, bondAmt);
        vm.startPrank(op);
        sm.register(vm.addr(pk));
        usdc.approve(address(sm), type(uint256).max);
        sm.bond(bondAmt);
        _setAlloc(baseAlloc, arbAlloc);
        vm.stopPrank();
        id = sm.idByOperator(op);
        pks.push(pk);
        operators.push(op);
        vids.push(id);
    }

    function _setAlloc(uint256 baseAlloc, uint256 arbAlloc) internal {
        uint64[] memory cs = new uint64[](2);
        cs[0] = BASE;
        cs[1] = ARB;
        uint256[] memory as_ = new uint256[](2);
        as_[0] = baseAlloc;
        as_[1] = arbAlloc;
        sm.setAllocations(cs, as_);
    }

    function _addValidators(uint256 n, uint256 bondAmt, uint256 baseAlloc, uint256 arbAlloc) internal {
        for (uint256 i; i < n; ++i) {
            _addValidator(bondAmt, baseAlloc, arbAlloc);
        }
    }

    function _advance() internal {
        vm.warp(block.timestamp + EPOCH);
        sm.advanceEpoch();
    }

    function _allPks() internal view returns (uint256[] memory out) {
        out = pks;
    }

    function _pks(uint256 a, uint256 b) internal view returns (uint256[] memory out) {
        out = new uint256[](b - a);
        for (uint256 i = a; i < b; ++i) {
            out[i - a] = pks[i];
        }
    }

    // ------------------------------------------------------------------ signing

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signAll(uint64 chain, uint64 epoch, L2Deposit[] memory deps, uint256[] memory signerPks)
        internal
        view
        returns (address[] memory signers, bytes[] memory sigs)
    {
        uint256 m = signerPks.length;
        uint256[] memory sorted = new uint256[](m);
        for (uint256 i; i < m; ++i) {
            sorted[i] = signerPks[i];
        }
        for (uint256 i = 1; i < m; ++i) {
            uint256 key = sorted[i];
            uint256 j = i;
            while (j > 0 && vm.addr(sorted[j - 1]) > vm.addr(key)) {
                sorted[j] = sorted[j - 1];
                --j;
            }
            sorted[j] = key;
        }
        bytes32 digest = dm.batchDigest(chain, epoch, deps);
        signers = new address[](m);
        sigs = new bytes[](m);
        for (uint256 i; i < m; ++i) {
            signers[i] = vm.addr(sorted[i]);
            sigs[i] = _sig(sorted[i], digest);
        }
    }

    function _attest(uint64 chain, uint64 epoch, L2Deposit[] memory deps, uint256[] memory signerPks)
        internal
        returns (uint256 batchId)
    {
        (address[] memory signers, bytes[] memory sigs) = _signAll(chain, epoch, deps, signerPks);
        vm.prank(submitter);
        batchId = dm.submitAttestation(chain, epoch, deps, signers, sigs);
    }

    // ------------------------------------------------------------------ canonical spoke model

    function _fee(uint64 chain) internal pure returns (uint256) {
        return chain == BASE ? BASE_INS + BASE_FIN : 0;
    }

    function _digestOf(uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("owner", salt))) % P;
    }

    function _spokeDeposit(uint64 chain, uint256 amount) internal returns (L2Deposit memory d) {
        SpokeModel storage s = spokes[chain];
        s.l2Block += 1;
        d = L2Deposit({
            index: uint64(s.deps.length),
            ownerDigest: _digestOf(++_nonceDigest),
            amount: amount,
            fee: _fee(chain),
            l2Block: s.l2Block
        });
        s.deps.push(d);
    }

    function _spokeDeposits(uint64 chain, uint256 n, uint256 amount) internal returns (L2Deposit[] memory ds) {
        ds = new L2Deposit[](n);
        for (uint256 i; i < n; ++i) {
            ds[i] = _spokeDeposit(chain, amount);
        }
    }

    function _spokeCount(uint64 chain) internal view returns (uint64) {
        return uint64(spokes[chain].deps.length);
    }

    function _bumpL2(uint64 chain) internal {
        spokes[chain].l2Block += 1;
    }

    /// @dev Builds the next canonical checkpoint (at most maxItems) and delivers it via the adapter.
    function _sendCheckpoint(uint64 chain, uint256 maxItems) internal returns (uint64 seq, bytes memory body) {
        SpokeModel storage s = spokes[chain];
        s.l2Block += 1;
        uint64 from = s.nextFrom;
        uint64 count = uint64(s.deps.length);
        uint64 to = count;
        if (to - from > maxItems) to = from + uint64(maxItems);
        L2Deposit[] memory ds = new L2Deposit[](to - from);
        for (uint64 i = from; i < to; ++i) {
            ds[i - from] = s.deps[i];
        }
        seq = s.seq++;
        s.nextFrom = to;
        body = abi.encode(
            Checkpoint({seq: seq, from: from, to: to, countAtSend: count, l2Block: s.l2Block, deposits: ds})
        );
        payloads[chain][seq] = body;
        (chain == BASE ? baseAdapter : arbAdapter).deliver(body);
    }

    function _process(uint64 chain, uint64 seq, uint256 maxItems) internal {
        vm.prank(processor);
        dm.processCheckpoint(chain, seq, payloads[chain][seq], maxItems);
    }

    function _checkpointAll(uint64 chain) internal {
        while (spokes[chain].nextFrom < spokes[chain].deps.length) {
            (uint64 seq,) = _sendCheckpoint(chain, 64);
            _process(chain, seq, 0);
        }
    }

    // ------------------------------------------------------------------ misc

    function _one(L2Deposit memory d) internal pure returns (L2Deposit[] memory ds) {
        ds = new L2Deposit[](1);
        ds[0] = d;
    }

    function _commit(uint256 amount, uint256 ownerDigest) internal view returns (uint256) {
        return IPoseidonT4(poseidon).hash([amount, 1, ownerDigest]);
    }

    function _unusedPoseidonRef() internal pure returns (bytes4) {
        return PoseidonT4.hash.selector;
    }
}
