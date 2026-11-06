// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IDepositManager} from "../interfaces/IDepositManager.sol";
import {IHubCore} from "../interfaces/IHubCore.sol";
import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";
import {IStakeManager} from "../interfaces/IStakeManager.sol";
import {IPoseidonT4} from "../interfaces/IPoseidon.sol";
import {DepositManagerConfig} from "../libraries/DeployConfig.sol";
import {
    L2Deposit,
    Checkpoint,
    P,
    TOKEN_ID,
    MAX_BATCH,
    MAX_VALIDATORS,
    MAX_ENC_LEN,
    AMOUNT_BOUND,
    FRAUD_MISMATCH,
    FRAUD_ABSENCE,
    FRAUD_EQUIVOCATION
} from "../libraries/Types.sol";

/// @title DepositManager (PRD 7.5) — Ethereum deposits, fast-lane attestations (R1–R3),
///        canonical checkpoints and fraud proofs.
/// @notice The hub computes every deposit commitment itself: C = PoseidonT4(a, 1, P).
///         Fast-lane value is never credited to L[c] until a canonical checkpoint confirms it, and
///         signer exposure clears only on that confirmation (never on time).
/// @dev Ethereum TVL cap (builder's call): the L1 vault balance, i.e.
///      `usdc.balanceOf(liquidityManager) + amount ≤ tvlCapEth`, mirroring the spokes' vault-balance cap.
contract DepositManager is IDepositManager, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ extra errors
    error AlreadySlashed();
    error CheckpointDone();
    error BadConfig();

    // ------------------------------------------------------------------ constants
    bytes32 public constant L2DEPOSIT_TYPEHASH =
        keccak256("L2Deposit(uint64 index,uint256 ownerDigest,uint256 amount,uint256 fee,uint64 l2Block)");
    bytes32 public constant BATCH_TYPEHASH = keccak256(
        "DepositBatch(uint64 srcChainId,address spoke,uint64 epoch,L2Deposit[] deposits)"
        "L2Deposit(uint64 index,uint256 ownerDigest,uint256 amount,uint256 fee,uint64 l2Block)"
    );
    uint256 private constant MAX_FRACTION = 1e18;

    // ------------------------------------------------------------------ immutables
    address public immutable hub;
    address public immutable liquidityManager;
    address public immutable stakeManager;
    address public immutable poseidonT4;
    IERC20 public immutable usdc;
    uint64 public immutable baseChainId;
    address public immutable baseAdapter;
    address public immutable baseSpoke;
    uint64 public immutable arbChainId;
    address public immutable arbAdapter;
    address public immutable arbSpoke;
    uint256 public immutable baseSettleInsert;
    uint256 public immutable baseSettleFinal;
    uint256 public immutable arbSettleInsert;
    uint256 public immutable arbSettleFinal;
    uint256 public immutable minDeposit;
    uint256 public immutable maxDepositHardMax;
    uint256 public immutable maxFastDepositHardMax;
    uint256 public immutable tvlCapHardMax;
    uint256 public immutable betaMaxNum;
    uint256 public immutable betaMaxDen;

    // ------------------------------------------------------------------ guardian-tunable caps
    uint256 public maxDeposit;
    uint256 public maxFastDeposit;
    uint256 public tvlCapEth;
    uint256 public betaNum;
    uint256 public betaDen;

    // ------------------------------------------------------------------ state
    struct Batch {
        address submitter;
        uint32 itemCount;
        uint32 confirmedCount;
        BatchStatus status;
        uint64 chainId;
        uint64 epoch;
        uint128 amount; // A
        uint128 sQ; // S_Q (effective stake of the signers)
        uint128 insertBounty; // accumulated canonical insert fees, paid to submitter on confirmation
        bytes32 depositsHash; // keccak256(abi.encodePacked(itemHash_0, ..., itemHash_n))
        uint32[] signerIds;
        uint128[] xs; // x_v(B), same order as signerIds
    }

    struct Item {
        uint64 batchId; // 0 = not attested through the fast lane
        bool inserted;
        bool confirmed;
        bytes32 hash; // keccak256(abi.encode(L2Deposit)) as attested (fast items only)
    }

    struct CheckpointRec {
        bytes32 payloadHash;
        uint64 from;
        uint64 to;
        uint64 countAtSend;
        uint64 l2Block;
        uint64 nextItem;
    }

    struct Quorum {
        uint64 chainId;
        uint64 epoch;
        uint64 cur;
        uint256 total; // A
        bytes32 depositsHash;
        uint32[] ids;
        uint256[] s;
        uint256[] xs;
        uint256 sQ;
    }

    struct Proc {
        uint256 credit;
        uint256 bounty;
        uint256[] slowCs;
        uint64[] slowIdx;
        uint256 slowCount;
        uint256 slowAmount;
        uint256 feeInsert;
        uint256 feeFinal;
    }

    uint256 public unconfirmedFastValue;
    uint256 public batchCount;
    mapping(uint256 => Batch) internal _batches;
    mapping(uint64 => mapping(uint64 => Item)) internal _items;
    mapping(uint64 => mapping(uint64 => CheckpointRec)) internal _checkpoints;

    constructor(DepositManagerConfig memory c) EIP712("xpool", "1") {
        if (
            c.hub == address(0) || c.liquidityManager == address(0) || c.stakeManager == address(0)
                || c.poseidonT4 == address(0) || c.usdc == address(0) || c.baseAdapter == address(0)
                || c.baseSpoke == address(0)
        ) revert BadConfig();
        // Arbitrum is optional: arbChainId == 0 disables it (adapter and spoke must then be unset).
        bool arbOn = c.arbChainId != 0;
        if (arbOn != (c.arbAdapter != address(0)) || arbOn != (c.arbSpoke != address(0))) revert BadConfig();
        if (c.baseChainId == 0 || c.baseChainId == c.arbChainId) revert BadConfig();
        if (c.baseChainId == block.chainid || c.arbChainId == block.chainid) revert BadConfig();
        if (c.minDeposit == 0 || c.maxDepositHardMax >= AMOUNT_BOUND) revert BadConfig();
        if (c.maxFastDepositHardMax > type(uint128).max / MAX_BATCH) revert BadConfig();
        if (c.betaMaxDen == 0 || c.betaMaxNum > MAX_FRACTION || c.betaMaxDen > MAX_FRACTION) revert BadConfig();

        hub = c.hub;
        liquidityManager = c.liquidityManager;
        stakeManager = c.stakeManager;
        poseidonT4 = c.poseidonT4;
        usdc = IERC20(c.usdc);
        baseChainId = c.baseChainId;
        baseAdapter = c.baseAdapter;
        baseSpoke = c.baseSpoke;
        arbChainId = c.arbChainId;
        arbAdapter = c.arbAdapter;
        arbSpoke = c.arbSpoke;
        baseSettleInsert = c.baseSettleInsert;
        baseSettleFinal = c.baseSettleFinal;
        arbSettleInsert = c.arbSettleInsert;
        arbSettleFinal = c.arbSettleFinal;
        minDeposit = c.minDeposit;
        maxDepositHardMax = c.maxDepositHardMax;
        maxFastDepositHardMax = c.maxFastDepositHardMax;
        tvlCapHardMax = c.tvlCapHardMax;
        betaMaxNum = c.betaMaxNum;
        betaMaxDen = c.betaMaxDen;

        _setCaps(c.maxDeposit, c.maxFastDeposit, c.tvlCapEth, c.betaNum, c.betaDen);
    }

    // ================================================================== Ethereum deposits

    /// @inheritdoc IDepositManager
    function deposit(uint256 amount, uint256 ownerDigest, bytes calldata encNote) external nonReentrant {
        if (IHubCore(hub).inflowsPaused()) revert InflowsPaused();
        if (amount < minDeposit || amount > maxDeposit) revert BadAmount();
        if (ownerDigest >= P) revert FieldOverflow();
        if (encNote.length > MAX_ENC_LEN) revert EncNoteTooLong();
        if (usdc.balanceOf(liquidityManager) + amount > tvlCapEth) revert TvlCapExceeded();

        usdc.safeTransferFrom(msg.sender, liquidityManager, amount);
        uint256[] memory cs = new uint256[](1);
        cs[0] = _commitment(amount, ownerDigest);
        uint32 leafIndex = IHubCore(hub).insertDepositLeaves(cs, amount);
        ILiquidityManager(liquidityManager).credit(uint64(block.chainid), amount);
        emit L1Deposit(leafIndex, cs[0], amount, msg.sender, encNote);
    }

    // ================================================================== fast lane

    /// @inheritdoc IDepositManager
    function submitAttestation(
        uint64 srcChainId,
        uint64 epoch,
        L2Deposit[] calldata deposits,
        address[] calldata signers,
        bytes[] calldata sigs
    ) external nonReentrant returns (uint256 batchId) {
        // 1. fast lane open, supported chain, epoch ∈ {current, current − 1}
        if (IHubCore(hub).inflowsPaused()) revert InflowsPaused();
        _chainIdx(srcChainId);
        uint64 cur = IStakeManager(stakeManager).currentEpoch();
        if (epoch != cur && (cur == 0 || epoch != cur - 1)) revert BadEpoch();
        // 2. size
        if (deposits.length == 0 || deposits.length > MAX_BATCH) revert BadBatchSize();
        // 3. items (records them; any later revert rolls everything back)
        batchId = ++batchCount;
        Quorum memory q;
        q.chainId = srcChainId;
        q.epoch = epoch;
        q.cur = cur;
        (q.total, q.depositsHash) = _recordFastItems(srcChainId, batchId, deposits);
        // 4–7. signers, signatures, R1–R3
        _checkQuorum(q, _batchDigest(srcChainId, epoch, deposits), signers, sigs);
        // 8. global safety valve: betaDen·(U + A) ≤ betaNum·(lpAssets + insurance)
        _checkValve(q.total);

        // effects
        _storeBatch(batchId, srcChainId, epoch, deposits.length, q);
        unconfirmedFastValue += q.total;

        // interactions (trusted protocol contracts)
        IStakeManager(stakeManager).addExposure(q.ids, srcChainId, q.xs);
        _insertFast(srcChainId, deposits, q.total);
        emit BatchAttested(batchId, srcChainId, epoch, q.total, (uint256(1) << q.ids.length) - 1, msg.sender);
    }

    function _storeBatch(uint256 batchId, uint64 chainId, uint64 epoch, uint256 n, Quorum memory q) internal {
        Batch storage b = _batches[batchId];
        b.submitter = msg.sender;
        b.itemCount = uint32(n);
        b.status = BatchStatus.Pending;
        b.chainId = chainId;
        b.epoch = epoch;
        b.amount = SafeCast.toUint128(q.total);
        b.sQ = SafeCast.toUint128(q.sQ);
        b.depositsHash = q.depositsHash;
        b.signerIds = q.ids;
        for (uint256 i; i < q.xs.length; ++i) {
            b.xs.push(SafeCast.toUint128(q.xs[i]));
        }
    }

    function _insertFast(uint64 chainId, L2Deposit[] calldata deposits, uint256 total) internal {
        uint256 n = deposits.length;
        uint256[] memory cs = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            cs[i] = _commitment(deposits[i].amount, deposits[i].ownerDigest);
        }
        uint32 first = IHubCore(hub).insertDepositLeaves(cs, total);
        for (uint256 i; i < n; ++i) {
            emit L2DepositInserted(chainId, deposits[i].index, cs[i], first + uint32(i), true);
        }
    }

    // ================================================================== canonical checkpoints

    /// @inheritdoc IDepositManager
    function receiveCheckpoint(uint64 srcChainId, bytes calldata payload) external nonReentrant {
        uint256 ci = _chainIdx(srcChainId);
        if (msg.sender != (ci == 0 ? baseAdapter : arbAdapter)) revert OnlyAdapter();
        Checkpoint memory cp = abi.decode(payload, (Checkpoint));
        uint256 len = cp.deposits.length;
        if (cp.to < cp.from || cp.to - cp.from != len || cp.to > cp.countAtSend) revert BadCheckpoint();
        for (uint256 k; k < len; ++k) {
            if (cp.deposits[k].index != cp.from + k) revert BadCheckpoint();
        }
        CheckpointRec storage r = _checkpoints[srcChainId][cp.seq];
        if (r.payloadHash != bytes32(0)) revert DuplicateCheckpoint();
        r.payloadHash = keccak256(payload);
        r.from = cp.from;
        r.to = cp.to;
        r.countAtSend = cp.countAtSend;
        r.l2Block = cp.l2Block;
        r.nextItem = cp.from;
        emit CheckpointReceived(srcChainId, cp.seq, cp.from, cp.to, cp.countAtSend, cp.l2Block);
    }

    /// @inheritdoc IDepositManager
    /// @dev maxItems == 0 processes every remaining item.
    function processCheckpoint(uint64 srcChainId, uint64 seq, bytes calldata payload, uint256 maxItems)
        external
        nonReentrant
    {
        uint256 ci = _chainIdx(srcChainId);
        CheckpointRec storage r = _checkpoints[srcChainId][seq];
        if (r.payloadHash == bytes32(0)) revert UnknownCheckpoint();
        if (keccak256(payload) != r.payloadHash) revert PayloadMismatch();
        uint64 start = r.nextItem;
        uint64 to = r.to;
        if (start >= to) revert CheckpointDone();
        uint64 end = (maxItems == 0 || maxItems >= to - start) ? to : start + uint64(maxItems);
        r.nextItem = end;

        Checkpoint memory cp = abi.decode(payload, (Checkpoint));
        Proc memory p;
        p.slowCs = new uint256[](end - start);
        p.slowIdx = new uint64[](end - start);
        (p.feeInsert, p.feeFinal) = ci == 0 ? (baseSettleInsert, baseSettleFinal) : (arbSettleInsert, arbSettleFinal);

        for (uint256 k = start - cp.from; k < end - cp.from; ++k) {
            _processItem(srcChainId, cp.deposits[k], p);
        }

        _flush(srcChainId, p);
        emit CheckpointProcessed(srcChainId, seq, end, end == to);
    }

    // ================================================================== fraud proofs

    /// @inheritdoc IDepositManager
    function proveAbsence(
        uint64 srcChainId,
        uint64 seq,
        uint256 batchId,
        L2Deposit[] calldata batchDeposits,
        uint256 pos
    ) external nonReentrant {
        _chainIdx(srcChainId);
        CheckpointRec storage r = _checkpoints[srcChainId][seq];
        if (r.payloadHash == bytes32(0)) revert UnknownCheckpoint();
        if (batchId == 0 || batchId > batchCount) revert UnknownBatch();
        Batch storage b = _batches[batchId];
        if (b.chainId != srcChainId || pos >= batchDeposits.length) revert BatchDataMismatch();
        if (_depositsHash(batchDeposits) != b.depositsHash) revert BatchDataMismatch();
        L2Deposit calldata d = batchDeposits[pos];
        // The claimed deposit did not exist at the block it claims.
        if (d.index < r.countAtSend || d.l2Block >= r.l2Block) revert NotFraud();
        if (b.status == BatchStatus.Fraud) revert AlreadySlashed();
        if (b.status != BatchStatus.Pending) revert NotFraud();
        _slashBatch(batchId, b, FRAUD_ABSENCE, msg.sender);
    }

    /// @inheritdoc IDepositManager
    /// @dev `public` with memory arguments: ten calldata arguments (14 stack slots) don't fit the
    ///      legacy-codegen stack. Same ABI and selector as the interface.
    function proveEquivocation(
        uint64 srcChainId,
        address signer,
        uint64 epochA,
        L2Deposit[] memory depA,
        bytes memory sigA,
        uint256 posA,
        uint64 epochB,
        L2Deposit[] memory depB,
        bytes memory sigB,
        uint256 posB
    ) public nonReentrant {
        _proveEquivocation(EquivocationArgs(srcChainId, signer, epochA, depA, sigA, posA, epochB, depB, sigB, posB));
    }

    struct EquivocationArgs {
        uint64 srcChainId;
        address signer;
        uint64 epochA;
        L2Deposit[] depA;
        bytes sigA;
        uint256 posA;
        uint64 epochB;
        L2Deposit[] depB;
        bytes sigB;
        uint256 posB;
    }

    function _proveEquivocation(EquivocationArgs memory a) internal {
        uint64 chainId = a.srcChainId;
        _chainIdx(chainId);
        (uint32 id,, bool jailed) = IStakeManager(stakeManager).validatorBySigner(a.signer);
        if (id == 0) revert InvalidSigner(a.signer);
        if (a.posA >= a.depA.length || a.posB >= a.depB.length) revert BatchDataMismatch();
        uint64 index = a.depA[a.posA].index;
        if (index != a.depB[a.posB].index) revert NotFraud();
        if (keccak256(abi.encode(a.depA[a.posA])) == keccak256(abi.encode(a.depB[a.posB]))) revert NotFraud();
        if (!_signedByMem(_batchDigestMem(chainId, a.epochA, a.depA), a.sigA, a.signer)) {
            revert BadSignature(a.signer);
        }
        if (!_signedByMem(_batchDigestMem(chainId, a.epochB, a.depB), a.sigB, a.signer)) {
            revert BadSignature(a.signer);
        }
        if (jailed) revert AlreadySlashed();

        IStakeManager(stakeManager).slash(id, FRAUD_EQUIVOCATION, msg.sender, 0);
        emit FraudProven(_items[chainId][index].batchId, FRAUD_EQUIVOCATION, msg.sender);
    }

    // ================================================================== guardian

    /// @inheritdoc IDepositManager
    function setCaps(
        uint256 newMaxDeposit,
        uint256 newMaxFastDeposit,
        uint256 newTvlCapEth,
        uint256 newBetaNum,
        uint256 newBetaDen
    ) external nonReentrant {
        if (msg.sender != IHubCore(hub).guardian()) revert OnlyGuardian();
        _setCaps(newMaxDeposit, newMaxFastDeposit, newTvlCapEth, newBetaNum, newBetaDen);
    }

    // ================================================================== views

    /// @inheritdoc IDepositManager
    function batchDigest(uint64 srcChainId, uint64 epoch, L2Deposit[] calldata deposits)
        external
        view
        returns (bytes32)
    {
        return _batchDigest(srcChainId, epoch, deposits);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Safety-valve fraction β = num/den (staticcalled by LiquidityManager for LP exits).
    function beta() external view returns (uint256 num, uint256 den) {
        return (betaNum, betaDen);
    }

    function inserted(uint64 chainId, uint64 index) external view returns (bool) {
        return _items[chainId][index].inserted;
    }

    function confirmed(uint64 chainId, uint64 index) external view returns (bool) {
        return _items[chainId][index].confirmed;
    }

    function fastItem(uint64 chainId, uint64 index) external view returns (uint256 batchId, bytes32 itemHash) {
        Item storage it = _items[chainId][index];
        return (it.batchId, it.hash);
    }

    function batchStatus(uint256 batchId) external view returns (BatchStatus) {
        return _batches[batchId].status;
    }

    function batchSigners(uint256 batchId) external view returns (uint32[] memory ids) {
        return _batches[batchId].signerIds;
    }

    function batchExposures(uint256 batchId) external view returns (uint128[] memory xs) {
        return _batches[batchId].xs;
    }

    function batchInfo(uint256 batchId)
        external
        view
        returns (
            uint64 chainId,
            uint64 epoch,
            uint256 amount,
            uint256 sQ,
            uint32 itemCount,
            uint32 confirmedCount,
            BatchStatus status,
            address submitter,
            bytes32 depositsHash
        )
    {
        Batch storage b = _batches[batchId];
        return
            (b.chainId, b.epoch, b.amount, b.sQ, b.itemCount, b.confirmedCount, b.status, b.submitter, b.depositsHash);
    }

    function checkpointOf(uint64 chainId, uint64 seq) external view returns (CheckpointRec memory) {
        return _checkpoints[chainId][seq];
    }

    function spokeOf(uint64 chainId) external view returns (address) {
        if (chainId == 0) return address(0);
        if (chainId == baseChainId) return baseSpoke;
        if (chainId == arbChainId) return arbSpoke;
        return address(0);
    }

    // ================================================================== internals

    function _chainIdx(uint64 chainId) internal view returns (uint256) {
        if (chainId == 0) revert UnsupportedChain(chainId); // also covers a disabled Arbitrum
        if (chainId == baseChainId) return 0;
        if (chainId == arbChainId) return 1;
        revert UnsupportedChain(chainId);
    }

    function _commitment(uint256 amount, uint256 ownerDigest) internal view returns (uint256) {
        return IPoseidonT4(poseidonT4).hash([amount, TOKEN_ID, ownerDigest]);
    }

    function _setCaps(uint256 mxDep, uint256 mxFast, uint256 tvl, uint256 bNum, uint256 bDen) internal {
        if (mxDep < minDeposit || mxDep > maxDepositHardMax) revert OutOfBounds();
        if (mxFast < minDeposit || mxFast > maxFastDepositHardMax) revert OutOfBounds();
        if (tvl > tvlCapHardMax) revert OutOfBounds();
        if (bDen == 0 || bDen > MAX_FRACTION || bNum > MAX_FRACTION) revert OutOfBounds();
        if (bNum * betaMaxDen > betaMaxNum * bDen) revert OutOfBounds();
        maxDeposit = mxDep;
        maxFastDeposit = mxFast;
        tvlCapEth = tvl;
        betaNum = bNum;
        betaDen = bDen;
        emit CapsUpdated(mxDep, mxFast, tvl, bNum, bDen);
    }

    /// @dev Check 3 of PRD 7.5 per item, and record it as inserted through `batchId`.
    function _recordFastItems(uint64 chainId, uint256 batchId, L2Deposit[] calldata deps)
        internal
        returns (uint256 total, bytes32 depositsHash)
    {
        uint256 n = deps.length;
        uint256 minD = minDeposit;
        uint256 maxF = maxFastDeposit;
        bytes32[] memory hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            L2Deposit calldata d = deps[i];
            if (d.ownerDigest >= P) revert FieldOverflow();
            if (d.amount < minD || d.amount > maxF) revert BadAmount();
            Item storage it = _items[chainId][d.index];
            if (it.inserted) revert AlreadyInserted(chainId, d.index);
            bytes32 h = keccak256(abi.encode(d));
            it.inserted = true;
            it.batchId = uint64(batchId);
            it.hash = h;
            hs[i] = h;
            total += d.amount;
        }
        depositsHash = keccak256(abi.encodePacked(hs));
    }

    function _depositsHash(L2Deposit[] calldata deps) internal pure returns (bytes32) {
        uint256 n = deps.length;
        bytes32[] memory hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            hs[i] = keccak256(abi.encode(deps[i]));
        }
        return keccak256(abi.encodePacked(hs));
    }

    /// @dev Checks 4–7 of PRD 7.5. Effective stake of a signer is its snapshot for `epoch`; for a
    ///      grace-window submission (epoch = current − 1) it is min(s(epoch), s(current)), so a
    ///      validator can't use an old allocation on one chain while its new snapshot reallocated
    ///      the same stake to the other chain (no double counting across the epoch boundary).
    function _checkQuorum(Quorum memory q, bytes32 digest, address[] calldata signers, bytes[] calldata sigs)
        internal
        view
    {
        uint256 m = signers.length;
        for (uint256 i = 1; i < m; ++i) {
            if (signers[i] <= signers[i - 1]) revert SignersNotAscending();
        }
        if (sigs.length != m || m > MAX_VALIDATORS) revert LengthMismatch();

        q.ids = new uint32[](m);
        q.s = new uint256[](m);
        q.xs = new uint256[](m);
        for (uint256 i; i < m; ++i) {
            address signer = signers[i];
            (uint32 id, uint256 sv) = _signerStake(q, signer);
            if (!_signedBy(digest, sigs[i], signer)) revert BadSignature(signer);
            q.ids[i] = id;
            q.s[i] = sv;
            q.sQ += sv;
        }
        _checkRules(q, signers);
    }

    function _signerStake(Quorum memory q, address signer) internal view returns (uint32 id, uint256 sv) {
        IStakeManager sm = IStakeManager(stakeManager);
        bool jailed;
        (id,, jailed) = sm.validatorBySigner(signer);
        if (id == 0 || jailed) revert InvalidSigner(signer);
        sv = sm.allocation(id, q.chainId, q.epoch);
        if (q.epoch != q.cur) sv = Math.min(sv, sm.allocation(id, q.chainId, q.cur));
        if (sv == 0) revert InvalidSigner(signer);
    }

    function _checkRules(Quorum memory q, address[] calldata signers) internal view {
        IStakeManager sm = IStakeManager(stakeManager);
        (uint256 kNum, uint256 kDen) = sm.k();
        (uint256 thNum, uint256 thDen) = sm.theta();
        uint256 sTotal = sm.totalAllocation(q.chainId, q.epoch);
        // R1: θd·S_Q ≥ θn·S
        if (sTotal == 0 || thDen * q.sQ < thNum * sTotal) revert QuorumR1();
        // R2: kd·S_Q ≥ kn·A
        if (kDen * q.sQ < kNum * q.total) revert QuorumR2();
        // R3: kn·(e_v + x_v) ≤ kd·s_v, x_v = ceil(A·s_v / S_Q)
        uint256 m = q.ids.length;
        for (uint256 i; i < m; ++i) {
            uint256 x = Math.mulDiv(q.total, q.s[i], q.sQ, Math.Rounding.Ceil);
            uint256 e = sm.exposure(q.ids[i], q.chainId);
            if (kNum * (e + x) > kDen * q.s[i]) revert QuorumR3(signers[i]);
            q.xs[i] = x;
        }
    }

    function _checkValve(uint256 total) internal view {
        ILiquidityManager lm = ILiquidityManager(liquidityManager);
        uint256 buffers = lm.lpAssets() + lm.insurance();
        if (betaDen * (unconfirmedFastValue + total) > betaNum * buffers) revert SafetyValve();
    }

    function _signedBy(bytes32 digest, bytes calldata sig, address signer) internal pure returns (bool) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && rec == signer;
    }

    function _signedByMem(bytes32 digest, bytes memory sig, address signer) internal pure returns (bool) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && rec == signer;
    }

    /// @dev EIP-712 digest of DepositBatch (docs/IMPLEMENTATION.md "Shared formats").
    function _batchDigest(uint64 chainId, uint64 epoch, L2Deposit[] calldata deps) internal view returns (bytes32) {
        uint256 n = deps.length;
        bytes32[] memory hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            L2Deposit calldata d = deps[i];
            hs[i] = keccak256(abi.encode(L2DEPOSIT_TYPEHASH, d.index, d.ownerDigest, d.amount, d.fee, d.l2Block));
        }
        return _digestFromHashes(chainId, epoch, hs);
    }

    function _batchDigestMem(uint64 chainId, uint64 epoch, L2Deposit[] memory deps) internal view returns (bytes32) {
        uint256 n = deps.length;
        bytes32[] memory hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            L2Deposit memory d = deps[i];
            hs[i] = keccak256(abi.encode(L2DEPOSIT_TYPEHASH, d.index, d.ownerDigest, d.amount, d.fee, d.l2Block));
        }
        return _digestFromHashes(chainId, epoch, hs);
    }

    function _digestFromHashes(uint64 chainId, uint64 epoch, bytes32[] memory hs) internal view returns (bytes32) {
        address spoke = _chainIdx(chainId) == 0 ? baseSpoke : arbSpoke;
        return
            _hashTypedDataV4(
                keccak256(abi.encode(BATCH_TYPEHASH, chainId, spoke, epoch, keccak256(abi.encodePacked(hs))))
            );
    }

    /// @dev One checkpoint item (PRD 7.5 table). Every item is confirmed and credited exactly once.
    function _processItem(uint64 chainId, L2Deposit memory d, Proc memory p) internal {
        Item storage it = _items[chainId][d.index];
        if (it.confirmed) return; // I5: never confirm / credit twice
        it.confirmed = true;
        p.credit += d.amount + d.fee;
        // bounties never exceed the canonical fee actually paid on L2
        uint256 ins = Math.min(p.feeInsert, d.fee);
        uint256 fin = Math.min(p.feeFinal, d.fee - ins);
        emit DepositConfirmed(chainId, d.index);

        uint256 batchId = it.batchId;
        if (batchId != 0) {
            Batch storage b = _batches[batchId];
            if (it.hash == keccak256(abi.encode(d))) {
                // fast item, canonical data equals the attested data
                p.bounty += fin;
                b.confirmedCount += 1;
                if (b.status == BatchStatus.Pending) {
                    b.insertBounty += uint128(ins);
                    if (b.confirmedCount == b.itemCount) _confirmBatch(batchId, b);
                } else {
                    p.bounty += ins;
                }
                return;
            }
            // mismatch: slash the batch once, then insert the TRUE deposit's commitment
            if (b.status == BatchStatus.Pending) _slashBatch(batchId, b, FRAUD_MISMATCH, msg.sender);
        } else {
            it.inserted = true; // slow lane
        }
        p.bounty += ins + fin;
        p.slowCs[p.slowCount] = _commitment(d.amount, d.ownerDigest);
        p.slowIdx[p.slowCount] = d.index;
        p.slowCount += 1;
        p.slowAmount += d.amount;
    }

    /// @dev Inserts the collected slow-lane leaves in one call (pairs), then credits the ledger and
    ///      the processor's bounties.
    function _flush(uint64 chainId, Proc memory p) internal {
        if (p.slowCount != 0) {
            uint256[] memory cs = p.slowCs;
            uint256 cnt = p.slowCount;
            assembly ("memory-safe") {
                mstore(cs, cnt)
            }
            uint32 first = IHubCore(hub).insertDepositLeaves(cs, p.slowAmount);
            for (uint256 j; j < cnt; ++j) {
                emit L2DepositInserted(chainId, p.slowIdx[j], cs[j], first + uint32(j), false);
            }
        }
        if (p.credit != 0) ILiquidityManager(liquidityManager).credit(chainId, p.credit);
        if (p.bounty != 0) ILiquidityManager(liquidityManager).creditBounty(msg.sender, p.bounty);
    }

    function _confirmBatch(uint256 batchId, Batch storage b) internal {
        b.status = BatchStatus.Confirmed;
        unconfirmedFastValue -= b.amount;
        uint256 bounty = b.insertBounty;
        address submitter = b.submitter;
        (uint32[] memory ids, uint256[] memory xs) = _signersAndXs(b);
        IStakeManager(stakeManager).clearExposure(ids, b.chainId, xs);
        if (bounty != 0) ILiquidityManager(liquidityManager).creditBounty(submitter, bounty);
        emit BatchConfirmed(batchId);
    }

    /// @dev Slashes every signer with coveredLoss = x_v(B) (docs decision 6). Callers guarantee
    ///      status == Pending, so a batch is slashed and decremented at most once.
    function _slashBatch(uint256 batchId, Batch storage b, uint8 kind, address prover) internal {
        b.status = BatchStatus.Fraud;
        unconfirmedFastValue -= b.amount;
        // insert fees of items already confirmed in this batch: the submitter forfeits them
        uint256 bounty = b.insertBounty;
        b.insertBounty = 0;
        (uint32[] memory ids, uint256[] memory xs) = _signersAndXs(b);
        IStakeManager sm = IStakeManager(stakeManager);
        for (uint256 i; i < ids.length; ++i) {
            sm.slash(ids[i], kind, prover, xs[i]);
        }
        if (bounty != 0) ILiquidityManager(liquidityManager).creditBounty(prover, bounty);
        emit FraudProven(batchId, kind, prover);
    }

    function _signersAndXs(Batch storage b) internal view returns (uint32[] memory ids, uint256[] memory xs) {
        ids = b.signerIds;
        uint256 m = ids.length;
        xs = new uint256[](m);
        for (uint256 i; i < m; ++i) {
            xs[i] = b.xs[i];
        }
    }
}
