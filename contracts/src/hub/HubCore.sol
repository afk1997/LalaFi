// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IHubCore} from "../interfaces/IHubCore.sol";
import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";
import {IHubAdapter} from "../interfaces/IHubAdapter.sol";
import {IVerifier} from "../interfaces/IVerifier.sol";
import {
    P,
    AMOUNT_BOUND,
    MAX_ENC_LEN,
    EXT_DATA_VERSION,
    MSG_RELEASE,
    MSG_PAUSE,
    Proof,
    PublicInputs,
    ExtData,
    Release,
    BridgeParams
} from "../libraries/Types.sol";
import {HubCoreConfig} from "../libraries/DeployConfig.sol";
import {MerkleTreeWithHistory} from "../libraries/MerkleTreeWithHistory.sol";
import {ZeroHashes} from "../libraries/ZeroHashes.sol";
import {Field} from "../libraries/Field.sol";

/// @title HubCore (PRD 7.4): global tree, nullifier set, transact, release log, guardian (PRD 7.9).
/// @notice Holds no funds. Every USDC movement goes through LiquidityManager; every cross-chain
///         message goes through the immutable adapter of its destination. No upgradeability.
contract HubCore is IHubCore, MerkleTreeWithHistory, ReentrancyGuardTransient {
    error BadConfig();
    error EmptyLeaves();

    uint256 private constant _BPS = 10_000;
    uint256 private constant _MAX_PHI_BPS = 1_000; // hard sanity bound (10%) on the immutable fee
    uint64 public constant EMERGENCY_PAUSE_DURATION = 72 hours;
    uint64 public constant EMERGENCY_PAUSE_COOLDOWN = 30 days;

    // ------------------------------------------------------------------ immutables
    IVerifier public immutable verifier;
    address public immutable depositManager;
    ILiquidityManager public immutable liquidityManager;
    uint64 public immutable baseChainId;
    address public immutable baseAdapter;
    uint64 public immutable arbChainId;
    address public immutable arbAdapter;
    uint256 public immutable phiBps;
    uint256 public immutable relayerFeeBucket;
    uint256 public immutable minWithdrawEth;
    uint256 public immutable minWithdrawBase;
    uint256 public immutable minWithdrawArb;

    // ------------------------------------------------------------------ state
    address public guardian;
    bool public inflowsPaused;
    uint64 public spendsPausedUntil;
    uint64 public lastEmergencyPause;
    uint256 public shieldedSupply;
    mapping(uint256 nullifier => bool) internal _spent;
    mapping(uint64 dstChainId => uint64) public releaseCount;
    mapping(uint64 dstChainId => mapping(uint64 index => bytes32)) public releaseHash;

    modifier onlyGuardian() {
        address g = guardian;
        if (g == address(0) || msg.sender != g) revert OnlyGuardian();
        _;
    }

    constructor(HubCoreConfig memory c) MerkleTreeWithHistory(c.poseidonT3) {
        if (
            c.verifier.code.length == 0 || c.depositManager == address(0) || c.liquidityManager == address(0)
                || c.guardian == address(0) || c.baseAdapter == address(0) || c.arbAdapter == address(0)
        ) revert BadConfig();
        if (
            c.baseChainId == 0 || c.arbChainId == 0 || c.baseChainId == c.arbChainId || c.baseChainId == block.chainid
                || c.arbChainId == block.chainid
        ) revert BadConfig();
        if (c.phiBps > _MAX_PHI_BPS || c.relayerFeeBucket == 0) revert BadConfig();
        if (c.minWithdrawEth == 0 || c.minWithdrawBase == 0 || c.minWithdrawArb == 0) revert BadConfig();

        verifier = IVerifier(c.verifier);
        depositManager = c.depositManager;
        liquidityManager = ILiquidityManager(c.liquidityManager);
        guardian = c.guardian;
        baseChainId = c.baseChainId;
        baseAdapter = c.baseAdapter;
        arbChainId = c.arbChainId;
        arbAdapter = c.arbAdapter;
        phiBps = c.phiBps;
        relayerFeeBucket = c.relayerFeeBucket;
        minWithdrawEth = c.minWithdrawEth;
        minWithdrawBase = c.minWithdrawBase;
        minWithdrawArb = c.minWithdrawArb;
    }

    // ================================================================== spends

    /// @inheritdoc IHubCore
    function transact(Proof calldata proof, PublicInputs calldata pi, ExtData calldata ext, BridgeParams calldata bp)
        external
        payable
        nonReentrant
    {
        // ---- checks 1-5 (ExtData only) -------------------------------------------------------
        (uint256 v, address adapter) = _checkExtData(pi, ext);
        // ---- checks 6-9 (public inputs, nullifiers, binding, proof) --------------------------
        _checkProof(proof, pi, ext);
        // ---- check 10: liquidity --------------------------------------------------------------
        uint64 dst = ext.dstChainId;
        uint256 w = ext.withdrawAmount;
        if (w > 0) liquidityManager.reserve(dst, w);
        // msg.value is only meaningful for an L2 destination (the adapter checks the exact amount).
        if (adapter == address(0) && msg.value != 0) revert UnexpectedValue();

        // ---- effects ------------------------------------------------------------------------
        uint256 n0 = pi.inputNullifiers[0];
        uint256 n1 = pi.inputNullifiers[1];
        _spent[n0] = true;
        _spent[n1] = true;
        emit NewNullifier(n0);
        emit NewNullifier(n1);

        uint32 leafIndex = _insertPair(pi.outputCommitments[0], pi.outputCommitments[1]);
        shieldedSupply -= v; // checked: can only underflow if the proof system is broken
        emit NewCommitment(pi.outputCommitments[0], leafIndex, ext.encOut0);
        emit NewCommitment(pi.outputCommitments[1], leafIndex + 1, ext.encOut1);

        bytes32 spendId = keccak256(abi.encode(n0, n1));
        emit Spend(spendId, pi.root, dst, v);

        if (ext.protocolFee > 0) liquidityManager.accrueProtocolFee(ext.protocolFee);
        if (ext.relayerFee > 0) liquidityManager.payRelayer(ext.relayer, ext.relayerFee);

        // ---- interactions -------------------------------------------------------------------
        if (dst == 0) return;
        if (adapter == address(0)) {
            liquidityManager.payOnL1(ext.recipient, w);
        } else {
            uint64 index = releaseCount[dst]++;
            Release memory r =
                Release({dstChainId: dst, index: index, recipient: ext.recipient, amount: w, spendId: spendId});
            releaseHash[dst][index] = keccak256(abi.encode(r));
            emit ReleaseLogged(dst, index, ext.recipient, w, spendId);
            IHubAdapter(adapter).sendToSpoke{value: msg.value}(abi.encode(MSG_RELEASE, abi.encode(r)), bp);
        }
    }

    /// @inheritdoc IHubCore
    function resendRelease(Release calldata r, BridgeParams calldata bp) external payable nonReentrant {
        address adapter = _l2Adapter(r.dstChainId);
        if (adapter == address(0)) revert UnsupportedChain(r.dstChainId);
        bytes32 h = releaseHash[r.dstChainId][r.index];
        if (h == bytes32(0) || h != keccak256(abi.encode(r))) revert UnknownRelease();
        emit ReleaseResent(r.dstChainId, r.index);
        IHubAdapter(adapter).sendToSpoke{value: msg.value}(abi.encode(MSG_RELEASE, abi.encode(r)), bp);
    }

    // ================================================================== deposits

    /// @inheritdoc IHubCore
    function insertDepositLeaves(uint256[] calldata commitments, uint256 totalAmount)
        external
        nonReentrant
        returns (uint32 firstLeafIndex)
    {
        if (msg.sender != depositManager) revert OnlyDepositManager();
        uint256 n = commitments.length;
        if (n == 0) revert EmptyLeaves();
        for (uint256 i; i < n; ++i) {
            Field.requireField(commitments[i]);
        }
        firstLeafIndex = _nextIndex;
        uint256 i;
        for (; i + 1 < n; i += 2) {
            _insertPair(commitments[i], commitments[i + 1]);
        }
        if (i < n) _insertPair(commitments[i], ZeroHashes.Z0);
        shieldedSupply += totalAmount;
        emit LeavesInserted(firstLeafIndex, _nextIndex - firstLeafIndex, _lastRoot());
    }

    // ================================================================== guardian (PRD 7.9)

    /// @inheritdoc IHubCore
    function setInflowsPaused(bool paused) external nonReentrant onlyGuardian {
        inflowsPaused = paused;
        emit InflowsPaused(paused);
    }

    /// @inheritdoc IHubCore
    function pauseSpokeDeposits(uint64 chainId, bool paused, BridgeParams calldata bp)
        external
        payable
        nonReentrant
        onlyGuardian
    {
        address adapter = _l2Adapter(chainId);
        if (adapter == address(0)) revert UnsupportedChain(chainId);
        emit SpokeDepositsPauseSent(chainId, paused);
        IHubAdapter(adapter).sendToSpoke{value: msg.value}(abi.encode(MSG_PAUSE, abi.encode(paused)), bp);
    }

    /// @inheritdoc IHubCore
    function emergencyPauseSpends() external nonReentrant onlyGuardian {
        // spendsPausedUntil != 0 <=> a pause was used before. The 30-day cooldown (> 72h) also makes
        // extending or chaining an active pause impossible.
        if (spendsPausedUntil != 0 && block.timestamp < uint256(lastEmergencyPause) + EMERGENCY_PAUSE_COOLDOWN) {
            revert EmergencyCooldown();
        }
        uint64 until = uint64(block.timestamp) + EMERGENCY_PAUSE_DURATION;
        lastEmergencyPause = uint64(block.timestamp);
        spendsPausedUntil = until;
        emit EmergencySpendPause(until);
    }

    /// @inheritdoc IHubCore
    function renounceGuardian() external nonReentrant onlyGuardian {
        guardian = address(0);
        emit GuardianRenounced();
    }

    // ================================================================== views

    function isKnownRoot(uint256 root) external view returns (bool) {
        return _isKnownRoot(root);
    }

    function getLastRoot() external view returns (uint256) {
        return _lastRoot();
    }

    function nextLeafIndex() external view returns (uint32) {
        return _nextIndex;
    }

    function isSpent(uint256 nullifier) external view returns (bool) {
        return _spent[nullifier];
    }

    function isSupportedChain(uint64 chainId) public view returns (bool) {
        return chainId == block.chainid || chainId == baseChainId || chainId == arbChainId;
    }

    function adapterFor(uint64 chainId) external view returns (address) {
        if (chainId == block.chainid) return address(0);
        address a = _l2Adapter(chainId);
        if (a == address(0)) revert UnsupportedChain(chainId);
        return a;
    }

    function minWithdraw(uint64 dstChainId) public view returns (uint256) {
        if (dstChainId == block.chainid) return minWithdrawEth;
        if (dstChainId == baseChainId) return minWithdrawBase;
        if (dstChainId == arbChainId) return minWithdrawArb;
        revert UnsupportedChain(dstChainId);
    }

    // ================================================================== internal

    function _l2Adapter(uint64 chainId) internal view returns (address) {
        if (chainId == baseChainId) return baseAdapter;
        if (chainId == arbChainId) return arbAdapter;
        return address(0);
    }

    /// @dev PRD 7.4 checks 1-5. Returns v and the destination adapter (0 for dst = 0 or the hub chain).
    function _checkExtData(PublicInputs calldata pi, ExtData calldata ext)
        internal
        view
        returns (uint256 v, address adapter)
    {
        // 1. circuit breaker
        uint64 pausedUntil = spendsPausedUntil;
        if (block.timestamp < pausedUntil) revert SpendsPaused(pausedUntil);

        // 2. envelope
        if (ext.version != EXT_DATA_VERSION) revert BadVersion();
        if (ext.hubChainId != block.chainid) revert BadHubChain();
        if (ext.hub != address(this)) revert BadHub();
        if (ext.deadline < block.timestamp) revert Expired();
        if (ext.encOut0.length > MAX_ENC_LEN || ext.encOut1.length > MAX_ENC_LEN) revert EncOutTooLong();

        // 3. withdrawal shape
        uint64 dst = ext.dstChainId;
        uint256 w = ext.withdrawAmount;
        if (dst == 0) {
            if (ext.recipient != address(0) || w != 0 || ext.protocolFee != 0) revert BadWithdrawShape();
        } else {
            if (dst != block.chainid) {
                adapter = _l2Adapter(dst);
                if (adapter == address(0)) revert UnsupportedChain(dst);
            }
            if (ext.recipient == address(0)) revert BadWithdrawShape();
            if (w < minWithdraw(dst)) revert BelowMinWithdraw();
            if (ext.protocolFee != Math.mulDiv(w, phiBps, _BPS, Math.Rounding.Ceil)) revert BadProtocolFee();
        }

        // 4. relayer fee
        uint256 relayerFee = ext.relayerFee;
        if (relayerFee % relayerFeeBucket != 0) revert BadRelayerFee();
        if (relayerFee > 0 && ext.relayer == address(0)) revert BadRelayerFee();

        // 5. total value and publicAmount (each term bounded first so the sum can't overflow)
        if (w >= AMOUNT_BOUND || relayerFee >= AMOUNT_BOUND || ext.protocolFee >= AMOUNT_BOUND) {
            revert AmountTooLarge();
        }
        v = w + relayerFee + ext.protocolFee;
        if (v >= AMOUNT_BOUND) revert AmountTooLarge();
        if (pi.publicAmount != (v == 0 ? 0 : P - v)) revert BadPublicAmount();
    }

    /// @dev PRD 7.4 checks 6-9.
    function _checkProof(Proof calldata proof, PublicInputs calldata pi, ExtData calldata ext) internal view {
        // 6. root and field range of all 7 public inputs
        if (!_isKnownRoot(pi.root)) revert UnknownRoot();
        uint256 n0 = pi.inputNullifiers[0];
        uint256 n1 = pi.inputNullifiers[1];
        uint256 c0 = pi.outputCommitments[0];
        uint256 c1 = pi.outputCommitments[1];
        if (pi.root >= P || pi.publicAmount >= P || pi.extDataHash >= P || n0 >= P || n1 >= P || c0 >= P || c1 >= P) {
            revert FieldOverflow();
        }

        // 7. nullifiers
        if (n0 == n1) revert DuplicateNullifier();
        if (_spent[n0]) revert NullifierSpent(n0);
        if (_spent[n1]) revert NullifierSpent(n1);

        // 8. ExtData binding
        if (pi.extDataHash != uint256(keccak256(abi.encode(ext))) % P) revert BadExtDataHash();

        // 9. proof
        uint256[7] memory signals = [pi.root, pi.publicAmount, pi.extDataHash, n0, n1, c0, c1];
        if (!verifier.verifyProof(proof.a, proof.b, proof.c, signals)) revert InvalidProof();
    }
}
