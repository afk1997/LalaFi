// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IStakeManager} from "../interfaces/IStakeManager.sol";
import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";
import {StakeManagerConfig} from "../libraries/DeployConfig.sol";
import {MAX_VALIDATORS} from "../libraries/Types.sol";

/// @title StakeManager (PRD 7.6, 9) — validator registry, bonds, allocations, epochs, exposure,
///        slashing and rewards.
/// @notice Safety model (Theorem 9.4):
///   - Slashable stake of a validator is Σ = bonded + unbonding. Nothing leaves the contract except
///     through `withdrawUnbonded` (gated by exposure coverage), `claimRewards` (rewards only) and
///     `slash`.
///   - Global coverage (enforced on every exposure increase and every withdrawal):
///         kNum · Σ_c e_v^c  ≤  kDen · (bonded_v + unbonding_v)
///   - Per-chain coverage for the epochs a validator can sign in: every snapshot taken at
///     `advanceEpoch` is at least ceil(k · e_v^c) (decreases are deferred while exposure is open),
///     and `setAllocations` rejects a pending allocation below ceil(k · e_v^c).
///   - Exposure only decreases through `clearExposure` (canonical confirmation, called by the
///     DepositManager) or `slash`. Never on a timer.
contract StakeManager is IStakeManager, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ extra errors
    error InsufficientBond();
    error BadConfig();

    // ------------------------------------------------------------------ constants
    /// @dev Bounded activation queue (processed and emptied at every epoch).
    uint256 public constant MAX_CANDIDATES = 64;
    uint256 private constant BPS = 10_000;
    uint256 private constant MAX_FRACTION = 1e18;

    // ------------------------------------------------------------------ immutables
    IERC20 public immutable usdc;
    address public immutable depositManager;
    address public immutable liquidityManager;
    uint64 public immutable baseChainId;
    uint64 public immutable arbChainId;
    uint256 internal immutable _sMin;
    uint256 internal immutable _kNum;
    uint256 internal immutable _kDen;
    uint256 internal immutable _thetaNum;
    uint256 internal immutable _thetaDen;
    uint256 public immutable omegaBps;
    uint256 public immutable evictionMarginBps;
    uint64 public immutable epochSeconds;
    uint64 public immutable unbondSeconds;

    // ------------------------------------------------------------------ storage
    struct Validator {
        address operator;
        bool active; // member of the active set (snapshotted at the last advanceEpoch)
        bool jailed;
        bool queued; // in the activation queue
        address signer;
        uint64 unlockTime;
        uint256 bonded;
        uint256 unbonding;
        uint256[2] pending; // pending allocations [base, arb], applied at the next advanceEpoch
        uint256[2] exposure; // e_v^c [base, arb]
        uint256 rewards; // claimable rewards
    }

    uint32 public validatorCount;
    mapping(uint32 => Validator) internal _validators;
    mapping(address => uint32) public idByOperator;
    mapping(address => uint32) public idBySigner;
    mapping(address => bool) public isJailedAddress;

    uint32[] internal _active;
    uint32[] internal _candidates;

    uint64 internal _epoch;
    mapping(uint64 => uint64) internal _epochStart;
    /// @dev epoch => id => packed allocation (base | arb << 128)
    mapping(uint64 => mapping(uint32 => uint256)) internal _alloc;
    /// @dev epoch => packed totals (base | arb << 128)
    mapping(uint64 => uint256) internal _totalAlloc;

    /// @notice Σ over validators of bonded + unbonding (slashable stake held here).
    uint256 public totalStake;
    /// @notice Σ of claimable rewards.
    uint256 public totalRewardsOwed;
    /// @notice Reward dust / forfeited rewards / pots with no allocated stake, carried to the next epoch.
    uint256 public undistributedRewards;

    modifier onlyDepositManager() {
        if (msg.sender != depositManager) revert OnlyDepositManager();
        _;
    }

    constructor(StakeManagerConfig memory c) {
        if (c.usdc == address(0) || c.depositManager == address(0) || c.liquidityManager == address(0)) {
            revert BadConfig();
        }
        // arbChainId == 0: Arbitrum disabled (allocations to it are rejected by _chainIdx).
        if (c.baseChainId == 0 || c.baseChainId == c.arbChainId) revert BadConfig();
        if (c.sMin == 0) revert BadConfig();
        if (c.kDen == 0 || c.kNum < c.kDen || c.kNum > MAX_FRACTION || c.kDen > MAX_FRACTION) revert BadConfig();
        if (c.thetaNum == 0 || c.thetaDen == 0 || c.thetaNum > c.thetaDen || c.thetaDen > MAX_FRACTION) {
            revert BadConfig();
        }
        if (c.omegaBps > BPS || c.evictionMarginBps > BPS) revert BadConfig();
        // Unbonding must outlast the attestation grace window (current and previous epoch).
        if (c.epochSeconds == 0 || c.unbondSeconds < 2 * uint256(c.epochSeconds)) revert BadConfig();

        usdc = IERC20(c.usdc);
        depositManager = c.depositManager;
        liquidityManager = c.liquidityManager;
        baseChainId = c.baseChainId;
        arbChainId = c.arbChainId;
        _sMin = c.sMin;
        _kNum = c.kNum;
        _kDen = c.kDen;
        _thetaNum = c.thetaNum;
        _thetaDen = c.thetaDen;
        omegaBps = c.omegaBps;
        evictionMarginBps = c.evictionMarginBps;
        epochSeconds = c.epochSeconds;
        unbondSeconds = c.unbondSeconds;
        _epochStart[0] = uint64(block.timestamp);
    }

    // ================================================================== operator actions

    /// @inheritdoc IStakeManager
    function register(address signer) external nonReentrant {
        if (signer == address(0) || signer == msg.sender) revert BadSigner();
        if (isJailedAddress[msg.sender] || isJailedAddress[signer]) revert Jailed();
        if (
            idByOperator[msg.sender] != 0 || idBySigner[msg.sender] != 0 || idByOperator[signer] != 0
                || idBySigner[signer] != 0
        ) revert AlreadyRegistered();

        uint32 id = ++validatorCount;
        Validator storage v = _validators[id];
        v.operator = msg.sender;
        v.signer = signer;
        idByOperator[msg.sender] = id;
        idBySigner[signer] = id;
        emit Registered(id, msg.sender, signer);
    }

    /// @inheritdoc IStakeManager
    function bond(uint256 amount) external nonReentrant {
        (uint32 id, Validator storage v) = _callerValidator();
        if (amount == 0) revert ZeroAmount();
        uint256 newBonded = v.bonded + amount;
        if (newBonded < _sMin) revert BelowMinBond();

        v.bonded = newBonded;
        totalStake += amount;
        if (!v.active && !v.queued) _enqueue(id, v);

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Bonded(id, amount);
    }

    /// @inheritdoc IStakeManager
    function setAllocations(uint64[] calldata chainIds, uint256[] calldata amounts) external nonReentrant {
        (uint32 id, Validator storage v) = _callerValidator();
        uint256 n = chainIds.length;
        if (n != amounts.length || n > 2) revert LengthMismatch();

        uint256[2] memory next;
        uint256 seen;
        for (uint256 i; i < n; ++i) {
            uint256 idx = _chainIdx(chainIds[i]);
            if (seen & (1 << idx) != 0) revert LengthMismatch();
            seen |= 1 << idx;
            next[idx] = amounts[i];
        }
        if (next[0] + next[1] > v.bonded) revert OverAllocated();
        // Coverage rule (PRD 7.6): never schedule an allocation below k·e_v^c.
        for (uint256 c; c < 2; ++c) {
            if (_kNum * v.exposure[c] > _kDen * next[c]) revert ExposureNotCovered();
        }
        v.pending = next;
        emit AllocationsSet(id, _epoch + 1);
    }

    /// @inheritdoc IStakeManager
    /// @dev The amount stays slashable (unbonding) until withdrawn. Pending allocations are scaled
    ///      down to fit the remaining bond; the snapshot keeps covering open exposure (deferral).
    function requestUnbond(uint256 amount) external nonReentrant {
        (uint32 id, Validator storage v) = _callerValidator();
        if (amount == 0) revert ZeroAmount();
        if (amount > v.bonded) revert InsufficientBond();

        uint256 remaining = v.bonded - amount;
        v.bonded = remaining;
        v.unbonding += amount;
        uint64 unlock = uint64(block.timestamp) + unbondSeconds;
        v.unlockTime = unlock;

        uint256 sum = v.pending[0] + v.pending[1];
        if (sum > remaining) {
            v.pending[0] = Math.mulDiv(v.pending[0], remaining, sum);
            v.pending[1] = Math.mulDiv(v.pending[1], remaining, sum);
        }
        emit UnbondRequested(id, amount, unlock);
    }

    /// @inheritdoc IStakeManager
    /// @dev I10: refuses while the remaining bond doesn't cover k·(total exposure).
    function withdrawUnbonded() external nonReentrant {
        uint32 id = idByOperator[msg.sender];
        if (id == 0) revert NotRegistered();
        Validator storage v = _validators[id];
        uint256 amount = v.unbonding;
        if (amount == 0) revert NothingToWithdraw();
        if (block.timestamp < v.unlockTime) revert StillLocked();
        if (_kNum * (v.exposure[0] + v.exposure[1]) > _kDen * v.bonded) revert ExposureNotCovered();

        v.unbonding = 0;
        totalStake -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit UnbondWithdrawn(id, amount);
    }

    /// @inheritdoc IStakeManager
    function claimRewards() external nonReentrant {
        uint32 id = idByOperator[msg.sender];
        if (id == 0) revert NotRegistered();
        Validator storage v = _validators[id];
        uint256 amount = v.rewards;
        if (amount == 0) revert NothingToWithdraw();
        v.rewards = 0;
        totalRewardsOwed -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit RewardsClaimed(id, amount);
    }

    /// @inheritdoc IStakeManager
    function advanceEpoch() external nonReentrant {
        uint64 cur = _epoch;
        if (block.timestamp < uint256(_epochStart[cur]) + epochSeconds) revert EpochNotDue();

        _distributeRewards(cur);

        uint64 next = cur + 1;
        _epoch = next;
        _epochStart[next] = uint64(block.timestamp);

        _dropIneligible();
        _processCandidates(next);
        _snapshot(next);

        emit EpochAdvanced(next);
    }

    // ================================================================== only DepositManager

    /// @inheritdoc IStakeManager
    function addExposure(uint32[] calldata ids, uint64 chainId, uint256[] calldata x) external onlyDepositManager {
        uint256 n = ids.length;
        if (n != x.length) revert LengthMismatch();
        uint256 idx = _chainIdx(chainId);
        for (uint256 i; i < n; ++i) {
            Validator storage v = _validatorOf(ids[i]);
            if (v.jailed) revert Jailed();
            uint256 e = v.exposure[idx] + x[i];
            v.exposure[idx] = e;
            // Global coverage: exposure across all chains never exceeds slashable stake / k.
            if (_kNum * (v.exposure[0] + v.exposure[1]) > _kDen * (v.bonded + v.unbonding)) {
                revert ExposureNotCovered();
            }
            emit ExposureAdded(ids[i], chainId, x[i]);
        }
    }

    /// @inheritdoc IStakeManager
    function clearExposure(uint32[] calldata ids, uint64 chainId, uint256[] calldata x) external onlyDepositManager {
        uint256 n = ids.length;
        if (n != x.length) revert LengthMismatch();
        uint256 idx = _chainIdx(chainId);
        for (uint256 i; i < n; ++i) {
            Validator storage v = _validatorOf(ids[i]);
            uint256 e = v.exposure[idx];
            // Saturating: a slashed validator's exposure was already zeroed.
            uint256 amt = x[i] < e ? x[i] : e;
            if (amt == 0) continue;
            v.exposure[idx] = e - amt;
            emit ExposureCleared(ids[i], chainId, amt);
        }
    }

    /// @inheritdoc IStakeManager
    /// @dev Returns 0 (no revert) for an already-jailed validator, so one slashBatch can't be
    ///      blocked by a signer slashed earlier. The prover reward is bounded with
    ///      max(coveredLoss, total open exposure of the validator): insurance always receives at
    ///      least all value the validator could still owe, even when it signed several fraudulent
    ///      batches or is slashed first for equivocation (coveredLoss = 0).
    function slash(uint32 id, uint8 reason, address prover, uint256 coveredLoss)
        external
        onlyDepositManager
        returns (uint256 slashed)
    {
        Validator storage v = _validatorOf(id);
        if (v.jailed) return 0;

        slashed = v.bonded + v.unbonding;
        uint256 owed = v.exposure[0] + v.exposure[1];
        if (coveredLoss > owed) owed = coveredLoss;

        // effects
        v.jailed = true;
        v.bonded = 0;
        v.unbonding = 0;
        delete v.pending;
        delete v.exposure;
        isJailedAddress[v.operator] = true;
        isJailedAddress[v.signer] = true;
        if (v.active) _removeActive(id, v);
        if (v.rewards != 0) {
            undistributedRewards += v.rewards;
            totalRewardsOwed -= v.rewards;
            v.rewards = 0;
        }
        totalStake -= slashed;

        uint256 reward;
        if (slashed > owed && prover != address(0)) {
            reward = Math.min(Math.mulDiv(slashed, omegaBps, BPS), slashed - owed);
        }
        // interactions
        if (reward != 0 && !_tryTransfer(prover, reward)) reward = 0; // e.g. blacklisted prover
        uint256 remainder = slashed - reward;
        if (remainder != 0) {
            usdc.safeTransfer(liquidityManager, remainder);
            ILiquidityManager(liquidityManager).receiveSlashed(remainder);
        }
        emit Slashed(id, slashed, reason, prover, reward);
    }

    // ================================================================== views

    function currentEpoch() external view returns (uint64) {
        return _epoch;
    }

    function epochStart(uint64 epoch) external view returns (uint64) {
        return _epochStart[epoch];
    }

    function allocation(uint32 id, uint64 chainId, uint64 epoch) external view returns (uint256) {
        return _unpack(_alloc[epoch][id], _chainIdx(chainId));
    }

    function totalAllocation(uint64 chainId, uint64 epoch) external view returns (uint256) {
        return _unpack(_totalAlloc[epoch], _chainIdx(chainId));
    }

    function exposure(uint32 id, uint64 chainId) external view returns (uint256) {
        return _validators[id].exposure[_chainIdx(chainId)];
    }

    function validatorBySigner(address signer) external view returns (uint32 id, bool active, bool jailed) {
        id = idBySigner[signer];
        Validator storage v = _validators[id];
        return (id, v.active, v.jailed);
    }

    function operatorOf(uint32 id) external view returns (address) {
        return _validators[id].operator;
    }

    function signerOf(uint32 id) external view returns (address) {
        return _validators[id].signer;
    }

    function bondedOf(uint32 id) external view returns (uint256) {
        return _validators[id].bonded;
    }

    function unbondingOf(uint32 id) external view returns (uint256 amount, uint64 unlockTime) {
        Validator storage v = _validators[id];
        return (v.unbonding, v.unlockTime);
    }

    function pendingRewards(uint32 id) external view returns (uint256) {
        return _validators[id].rewards;
    }

    function pendingAllocations(uint32 id) external view returns (uint256 base, uint256 arb) {
        Validator storage v = _validators[id];
        return (v.pending[0], v.pending[1]);
    }

    function isJailed(uint32 id) external view returns (bool) {
        return _validators[id].jailed;
    }

    function activeValidators() external view returns (uint32[] memory) {
        return _active;
    }

    function candidates() external view returns (uint32[] memory) {
        return _candidates;
    }

    function sMin() external view returns (uint256) {
        return _sMin;
    }

    function k() external view returns (uint256 kNum, uint256 kDen) {
        return (_kNum, _kDen);
    }

    function theta() external view returns (uint256 thetaNum, uint256 thetaDen) {
        return (_thetaNum, _thetaDen);
    }

    // ================================================================== internals

    function _callerValidator() internal view returns (uint32 id, Validator storage v) {
        id = idByOperator[msg.sender];
        if (id == 0) revert NotRegistered();
        v = _validators[id];
        if (v.jailed) revert Jailed();
    }

    function _validatorOf(uint32 id) internal view returns (Validator storage v) {
        if (id == 0 || id > validatorCount) revert NotRegistered();
        v = _validators[id];
    }

    function _chainIdx(uint64 chainId) internal view returns (uint256) {
        if (chainId == 0) revert UnsupportedChain(chainId);
        if (chainId == baseChainId) return 0;
        if (chainId == arbChainId) return 1;
        revert UnsupportedChain(chainId);
    }

    function _unpack(uint256 packed, uint256 idx) internal pure returns (uint256) {
        return idx == 0 ? uint128(packed) : packed >> 128;
    }

    function _eligible(Validator storage v) internal view returns (bool) {
        return !v.jailed && !v.active && v.bonded >= _sMin;
    }

    /// @dev Bounded queue. When full, the newcomer replaces the weakest (or a stale) queued
    ///      candidate if its bond is larger, so nobody can block entry by filling the queue.
    function _enqueue(uint32 id, Validator storage v) internal {
        uint256 len = _candidates.length;
        if (len < MAX_CANDIDATES) {
            _candidates.push(id);
            v.queued = true;
            return;
        }
        uint256 weakest;
        uint256 weakestBond = type(uint256).max;
        for (uint256 i; i < len; ++i) {
            Validator storage w = _validators[_candidates[i]];
            uint256 b = _eligible(w) ? w.bonded : 0;
            if (b < weakestBond) {
                weakestBond = b;
                weakest = i;
            }
        }
        if (v.bonded <= weakestBond) revert RegistryFull();
        _validators[_candidates[weakest]].queued = false;
        _candidates[weakest] = id;
        v.queued = true;
    }

    function _removeActive(uint32 id, Validator storage v) internal {
        v.active = false;
        uint256 len = _active.length;
        for (uint256 i; i < len; ++i) {
            if (_active[i] == id) {
                _active[i] = _active[len - 1];
                _active.pop();
                return;
            }
        }
    }

    /// @dev Active validators whose bond fell below sMin (unbonding) leave the set.
    function _dropIneligible() internal {
        uint256 i = _active.length;
        while (i > 0) {
            --i;
            uint32 id = _active[i];
            Validator storage v = _validators[id];
            if (v.jailed || v.bonded < _sMin) {
                v.active = false;
                _active[i] = _active[_active.length - 1];
                _active.pop();
            }
        }
    }

    /// @dev Activates queued candidates, strongest first. When the set is full, a candidate whose
    ///      bond exceeds the smallest active bond by more than the eviction margin replaces it.
    function _processCandidates(uint64 next) internal {
        uint256 n = _candidates.length;
        if (n == 0) return;

        // eligible candidates sorted by bond, descending
        uint32[] memory cand = new uint32[](n);
        uint256[] memory cb = new uint256[](n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            uint32 id = _candidates[i];
            Validator storage v = _validators[id];
            v.queued = false;
            if (!_eligible(v)) continue;
            uint256 b = v.bonded;
            uint256 j = m;
            while (j > 0 && cb[j - 1] < b) {
                cand[j] = cand[j - 1];
                cb[j] = cb[j - 1];
                --j;
            }
            cand[j] = id;
            cb[j] = b;
            ++m;
        }
        delete _candidates;
        if (m == 0) return;

        // active bonds in memory
        uint256 a = _active.length;
        uint256[] memory ab = new uint256[](MAX_VALIDATORS);
        for (uint256 i; i < a; ++i) {
            ab[i] = _validators[_active[i]].bonded;
        }

        for (uint256 i; i < m; ++i) {
            uint32 id = cand[i];
            if (a < MAX_VALIDATORS) {
                _active.push(id);
                ab[a] = cb[i];
                ++a;
            } else {
                uint256 minIdx;
                for (uint256 j = 1; j < a; ++j) {
                    if (ab[j] < ab[minIdx]) minIdx = j;
                }
                if (cb[i] * BPS <= ab[minIdx] * (BPS + evictionMarginBps)) continue;
                _evict(_active[minIdx], id);
                _active[minIdx] = id;
                ab[minIdx] = cb[i];
            }
            _validators[id].active = true;
            emit Activated(id, next);
        }
    }

    /// @dev The evicted validator's whole bond moves to unbonding; it stays slashable and its
    ///      withdrawal remains gated by exposure coverage.
    function _evict(uint32 id, uint32 by) internal {
        Validator storage v = _validators[id];
        v.active = false;
        uint256 amount = v.bonded;
        v.bonded = 0;
        v.unbonding += amount;
        uint64 unlock = uint64(block.timestamp) + unbondSeconds;
        v.unlockTime = unlock;
        delete v.pending;
        emit Evicted(id, by);
        emit UnbondRequested(id, amount, unlock);
    }

    /// @dev s_v^c(next) = max(pending^c, ceil(k·e_v^c)): an allocation decrease is deferred while
    ///      exposure is open, so k·e_v^c ≤ s_v^c holds in every epoch the validator signs in (I6).
    function _snapshot(uint64 next) internal {
        uint256 a = _active.length;
        uint256 t0;
        uint256 t1;
        for (uint256 i; i < a; ++i) {
            uint32 id = _active[i];
            Validator storage v = _validators[id];
            uint256 s0 = Math.max(v.pending[0], Math.ceilDiv(_kNum * v.exposure[0], _kDen));
            uint256 s1 = Math.max(v.pending[1], Math.ceilDiv(_kNum * v.exposure[1], _kDen));
            _alloc[next][id] = uint256(SafeCast.toUint128(s0)) | (uint256(SafeCast.toUint128(s1)) << 128);
            t0 += s0;
            t1 += s1;
        }
        _totalAlloc[next] = uint256(SafeCast.toUint128(t0)) | (uint256(SafeCast.toUint128(t1)) << 128);
    }

    /// @dev Pulls the pot from LiquidityManager (never blocks the epoch if that fails) and splits
    ///      it pro rata to Σ_c s_v^c(epoch) over the validators still active.
    function _distributeRewards(uint64 epoch) internal {
        uint256 before = usdc.balanceOf(address(this));
        try ILiquidityManager(liquidityManager).takeRewardPot() returns (uint256) {} catch {}
        uint256 afterBal = usdc.balanceOf(address(this));
        uint256 pot = undistributedRewards + (afterBal > before ? afterBal - before : 0);
        if (pot == 0) return;

        uint256 a = _active.length;
        uint256 packedTotal;
        uint256[] memory w = new uint256[](a);
        uint256 total;
        for (uint256 i; i < a; ++i) {
            packedTotal = _alloc[epoch][_active[i]];
            w[i] = uint128(packedTotal) + (packedTotal >> 128);
            total += w[i];
        }
        if (total == 0) {
            undistributedRewards = pot;
            return;
        }
        uint256 distributed;
        for (uint256 i; i < a; ++i) {
            if (w[i] == 0) continue;
            uint256 share = Math.mulDiv(pot, w[i], total);
            if (share == 0) continue;
            _validators[_active[i]].rewards += share;
            distributed += share;
        }
        totalRewardsOwed += distributed;
        undistributedRewards = pot - distributed;
        emit RewardsDistributed(epoch, distributed);
    }

    /// @dev USDC transfer that reports failure instead of reverting.
    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return address(usdc).code.length != 0;
        return ret.length == 32 && uint256(bytes32(ret)) == 1;
    }
}
