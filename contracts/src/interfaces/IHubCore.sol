// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Proof, PublicInputs, ExtData, Release, BridgeParams} from "../libraries/Types.sol";

/// @title HubCore (PRD 7.4) — global tree, nullifiers, transact, release log, guardian.
/// @notice HubCore is also the single source of truth for the guardian and the
///         inflow pause flag; DepositManager / LiquidityManager read them from here.
interface IHubCore {
    // ------------------------------------------------------------------ errors
    error SpendsPaused(uint64 until);
    error BadVersion();
    error BadHubChain();
    error BadHub();
    error Expired();
    error EncOutTooLong();
    error BadWithdrawShape();
    error UnsupportedChain(uint64 chainId);
    error BelowMinWithdraw();
    error BadProtocolFee();
    error BadRelayerFee();
    error AmountTooLarge();
    error BadPublicAmount();
    error UnknownRoot();
    error FieldOverflow();
    error DuplicateNullifier();
    error NullifierSpent(uint256 nullifier);
    error BadExtDataHash();
    error InvalidProof();
    error UnexpectedValue();
    error TreeFull();
    error OnlyDepositManager();
    error OnlyGuardian();
    error UnknownRelease();
    error EmergencyCooldown();

    // ------------------------------------------------------------------ events
    event NewCommitment(uint256 indexed commitment, uint32 indexed leafIndex, bytes encryptedOutput);
    event NewNullifier(uint256 indexed nullifier);
    event Spend(bytes32 indexed spendId, uint256 root, uint64 dstChainId, uint256 v);
    event ReleaseLogged(
        uint64 indexed dstChainId, uint64 indexed index, address recipient, uint256 amount, bytes32 spendId
    );
    event ReleaseResent(uint64 indexed dstChainId, uint64 indexed index);
    /// @dev Emitted for deposit leaves (and Z0 padding) inserted via insertDepositLeaves.
    event LeavesInserted(uint32 indexed firstLeafIndex, uint256 count, uint256 newRoot);
    event InflowsPaused(bool paused);
    event SpokeDepositsPauseSent(uint64 indexed chainId, bool paused);
    event EmergencySpendPause(uint64 until);
    event GuardianRenounced();

    // ------------------------------------------------------------------ spends
    function transact(Proof calldata proof, PublicInputs calldata pi, ExtData calldata ext, BridgeParams calldata bp)
        external
        payable;

    /// @notice Anyone; re-sends a logged release. Spoke execution is idempotent per index.
    function resendRelease(Release calldata r, BridgeParams calldata bp) external payable;

    // ------------------------------------------------------------------ deposits
    /// @notice Only DepositManager. Inserts in pairs (odd count padded with Z0), adds totalAmount
    ///         to shieldedSupply, returns the leaf index of commitments[0].
    function insertDepositLeaves(uint256[] calldata commitments, uint256 totalAmount)
        external
        returns (uint32 firstLeafIndex);

    // ------------------------------------------------------------------ guardian (PRD 7.9)
    function guardian() external view returns (address);
    function inflowsPaused() external view returns (bool);
    function setInflowsPaused(bool paused) external;
    /// @notice Sends MSG_PAUSE to a spoke. Releases are never paused.
    function pauseSpokeDeposits(uint64 chainId, bool paused, BridgeParams calldata bp) external payable;
    /// @notice spendsPausedUntil = now + 72h; at most once per 30 days; cannot be extended.
    function emergencyPauseSpends() external;
    function renounceGuardian() external;

    // ------------------------------------------------------------------ views
    function isKnownRoot(uint256 root) external view returns (bool);
    function getLastRoot() external view returns (uint256);
    function isSpent(uint256 nullifier) external view returns (bool);
    function nextLeafIndex() external view returns (uint32);
    function shieldedSupply() external view returns (uint256);
    function releaseCount(uint64 dstChainId) external view returns (uint64);
    function releaseHash(uint64 dstChainId, uint64 index) external view returns (bytes32);
    function spendsPausedUntil() external view returns (uint64);
    function isSupportedChain(uint64 chainId) external view returns (bool);
    /// @dev returns address(0) for the hub chain itself
    function adapterFor(uint64 chainId) external view returns (address);
    function phiBps() external view returns (uint256);
    function relayerFeeBucket() external view returns (uint256);
    function minWithdraw(uint64 dstChainId) external view returns (uint256);
}
