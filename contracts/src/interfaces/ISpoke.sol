// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Spoke (PRD 7.8) — Base (OpStackSpoke) and Arbitrum (ArbitrumSpoke).
/// @notice Abstract base `Spoke` implements all logic; subclasses implement only:
///           _isFromHub()       canonical origin check (OP: L2 messenger + xDomainMessageSender;
///                              Arbitrum: msg.sender == alias(hubAdapter))
///           _sendToHub(bytes)  canonical L2->L1 send (OP: L2 messenger; Arbitrum: ArbSys.sendTxToL1)
///           _l2BlockNumber()   OP: block.number; Arbitrum: ArbSys(100).arbBlockNumber()
interface ISpoke {
    struct StoredDeposit {
        uint256 ownerDigest;
        uint256 amount;
        uint256 fee;
        uint64 l2Block;
    }

    enum ReleaseState {
        None,
        Executed,
        Queued,
        Failed
    }

    // ------------------------------------------------------------------ errors
    error DepositsPaused();
    error BadAmount();
    error FieldOverflow();
    error EncNoteTooLong();
    error TvlCapExceeded();
    error NotFromHub();
    error EmptyCheckpointTooSoon();
    error NotFailed();

    // ------------------------------------------------------------------ events
    event Deposit(uint64 indexed index, uint256 ownerDigest, uint256 amount, uint256 fee, uint64 l2Block, bytes encNote);
    event CheckpointSent(uint64 indexed seq, uint64 from, uint64 to, uint64 countAtSend, uint64 l2Block);
    event ReleaseExecuted(uint64 indexed index, address recipient, uint256 amount);
    event ReleaseQueued(uint64 indexed index);
    event ReleaseFailed(uint64 indexed index);
    event RebalanceBurn(uint64 indexed nonce, uint256 amount, uint32 dstDomain, bytes32 mintRecipient);
    event DepositsPausedSet(bool paused);
    /// @dev Emitted when a hub message can't be applied (never reverts the bridge call).
    event HubMessageIgnored(uint8 kind, bytes reason);

    // ------------------------------------------------------------------ actions
    /// @notice Pulls amount + settleFee (insert + final). No Poseidon on L2.
    function deposit(uint256 amount, uint256 ownerDigest, bytes calldata encNote) external;
    /// @notice Permissionless; at most MAX_CHECKPOINT items; empty ones rate-limited.
    function sendCheckpoint() external;
    /// @notice Only canonical bridge from the hub adapter. MUST NOT revert on application errors.
    function receiveFromHub(bytes calldata message) external;
    /// @notice Permissionless; pays queued releases FIFO while liquidity allows.
    function processQueue(uint256 maxItems) external;
    /// @notice Permissionless; retries a release recorded as Failed (e.g. recipient was blacklisted).
    function retryFailedRelease(uint64 index) external;

    // ------------------------------------------------------------------ views
    function hubChainId() external view returns (uint64);
    function hubAdapter() external view returns (address);
    function usdc() external view returns (address);
    function depositCount() external view returns (uint64);
    function nextCheckpointFrom() external view returns (uint64);
    function checkpointSeq() external view returns (uint64);
    function getDeposit(uint64 index) external view returns (StoredDeposit memory);
    function releaseState(uint64 index) external view returns (ReleaseState);
    function queueLength() external view returns (uint256);
    function depositsPaused() external view returns (bool);
    function settleFeeInsert() external view returns (uint256);
    function settleFeeFinal() external view returns (uint256);
    function minDeposit() external view returns (uint256);
    function maxDeposit() external view returns (uint256);
    function l2BlockNumber() external view returns (uint64);
}
