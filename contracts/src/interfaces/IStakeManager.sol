// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title StakeManager (PRD 7.6) — validator registry, bonds, allocations, epochs, exposure, slashing, rewards.
/// @dev DEVIATION from PRD: validator ids are uint32 (registry-wide, never reused) instead of uint8,
///      so that >255 lifetime registrations (G7 open participation) can't exhaust the id space and
///      a jailed/evicted validator's id can never alias a newcomer inside a stored batch.
///      At most MAX_VALIDATORS (32) are *active* at once.
interface IStakeManager {
    // ------------------------------------------------------------------ errors
    error AlreadyRegistered();
    error NotRegistered();
    error Jailed();
    error BadSigner();
    error BelowMinBond();
    error RegistryFull();
    error LengthMismatch();
    error UnsupportedChain(uint64 chainId);
    error OverAllocated();
    error ExposureNotCovered();
    error NothingToWithdraw();
    error StillLocked();
    error EpochNotDue();
    error OnlyDepositManager();
    error ZeroAmount();

    // ------------------------------------------------------------------ events
    event Registered(uint32 indexed id, address operator, address signer);
    event Bonded(uint32 indexed id, uint256 amount);
    event AllocationsSet(uint32 indexed id, uint64 effectiveEpoch);
    event UnbondRequested(uint32 indexed id, uint256 amount, uint64 unlockTime);
    event UnbondWithdrawn(uint32 indexed id, uint256 amount);
    event EpochAdvanced(uint64 indexed epoch);
    event Activated(uint32 indexed id, uint64 epoch);
    event Slashed(uint32 indexed id, uint256 amount, uint8 reason, address prover, uint256 proverReward);
    event Evicted(uint32 indexed id, uint32 indexed replacedBy);
    event RewardsDistributed(uint64 indexed epoch, uint256 amount);
    event RewardsClaimed(uint32 indexed id, uint256 amount);
    event ExposureAdded(uint32 indexed id, uint64 indexed chainId, uint256 amount);
    event ExposureCleared(uint32 indexed id, uint64 indexed chainId, uint256 amount);

    // ------------------------------------------------------------------ operator actions
    function register(address signer) external; // operator = msg.sender
    function bond(uint256 amount) external; // USDC; effective next epoch
    function setAllocations(uint64[] calldata chainIds, uint256[] calldata amounts) external; // next epoch
    function requestUnbond(uint256 amount) external; // leaves active set next epoch
    function withdrawUnbonded() external; // after unbondSeconds, if exposure covered
    function claimRewards() external;
    function advanceEpoch() external; // permissionless once epochSeconds elapsed

    // ------------------------------------------------------------------ views
    function currentEpoch() external view returns (uint64);
    function epochStart(uint64 epoch) external view returns (uint64);
    /// @dev Snapshotted stake of `id` on `chainId` for `epoch` (0 if not active then).
    function allocation(uint32 id, uint64 chainId, uint64 epoch) external view returns (uint256);
    function totalAllocation(uint64 chainId, uint64 epoch) external view returns (uint256);
    function exposure(uint32 id, uint64 chainId) external view returns (uint256);
    function validatorBySigner(address signer) external view returns (uint32 id, bool active, bool jailed);
    function operatorOf(uint32 id) external view returns (address);
    function signerOf(uint32 id) external view returns (address);
    function bondedOf(uint32 id) external view returns (uint256);
    function unbondingOf(uint32 id) external view returns (uint256 amount, uint64 unlockTime);
    function pendingRewards(uint32 id) external view returns (uint256);
    function activeValidators() external view returns (uint32[] memory);
    function sMin() external view returns (uint256);
    /// @dev over-collateralization k = kNum/kDen, quorum theta = thetaNum/thetaDen
    function k() external view returns (uint256 kNum, uint256 kDen);
    function theta() external view returns (uint256 thetaNum, uint256 thetaDen);

    // ------------------------------------------------------------------ only DepositManager
    function addExposure(uint32[] calldata ids, uint64 chainId, uint256[] calldata x) external;
    function clearExposure(uint32[] calldata ids, uint64 chainId, uint256[] calldata x) external;
    /// @notice Takes the entire bonded + unbonding stake (Σ), jails forever.
    ///         Prover reward r = min(ω·Σ, Σ − coveredLoss); remainder → LiquidityManager.receiveSlashed.
    function slash(uint32 id, uint8 reason, address prover, uint256 coveredLoss) external returns (uint256 slashed);
}
