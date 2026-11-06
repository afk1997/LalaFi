// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {L2Deposit} from "../libraries/Types.sol";

/// @title DepositManager (PRD 7.5) — L1 deposits, fast lane, canonical checkpoints, fraud proofs.
interface IDepositManager {
    enum BatchStatus {
        None,
        Pending,
        Confirmed,
        Fraud
    }

    // ------------------------------------------------------------------ errors
    error InflowsPaused();
    error BadAmount();
    error FieldOverflow();
    error EncNoteTooLong();
    error TvlCapExceeded();
    error UnsupportedChain(uint64 chainId);
    error BadEpoch();
    error BadBatchSize();
    error AlreadyInserted(uint64 chainId, uint64 index);
    error SignersNotAscending();
    error LengthMismatch();
    error InvalidSigner(address signer);
    error BadSignature(address signer);
    error QuorumR1();
    error QuorumR2();
    error QuorumR3(address signer);
    error SafetyValve();
    error OnlyAdapter();
    error BadCheckpoint();
    error DuplicateCheckpoint();
    error UnknownCheckpoint();
    error PayloadMismatch();
    error UnknownBatch();
    error BatchDataMismatch();
    error NotFraud();
    error OnlyGuardian();
    error OutOfBounds();

    // ------------------------------------------------------------------ events
    event L1Deposit(uint32 indexed leafIndex, uint256 commitment, uint256 amount, address depositor, bytes encNote);
    event BatchAttested(
        uint256 indexed batchId,
        uint64 indexed srcChainId,
        uint64 epoch,
        uint256 totalAmount,
        uint256 signerBitmap, // bit i set => i-th entry of the batch's signer id list (see batchSigners)
        address submitter
    );
    event L2DepositInserted(
        uint64 indexed srcChainId, uint64 indexed index, uint256 commitment, uint32 leafIndex, bool fastLane
    );
    event CheckpointReceived(
        uint64 indexed srcChainId, uint64 indexed seq, uint64 from, uint64 to, uint64 countAtSend, uint64 l2Block
    );
    event CheckpointProcessed(uint64 indexed srcChainId, uint64 indexed seq, uint64 nextItem, bool done);
    event DepositConfirmed(uint64 indexed srcChainId, uint64 indexed index);
    event BatchConfirmed(uint256 indexed batchId);
    event FraudProven(uint256 indexed batchId, uint8 kind, address prover); // kind: 1 mismatch, 2 absence, 3 equivocation
    event CapsUpdated(uint256 maxDeposit, uint256 maxFastDeposit, uint256 tvlCapEth, uint256 betaNum, uint256 betaDen);

    // ------------------------------------------------------------------ Ethereum deposits [P0]
    function deposit(uint256 amount, uint256 ownerDigest, bytes calldata encNote) external;

    // ------------------------------------------------------------------ L2 fast lane [P0]
    function submitAttestation(
        uint64 srcChainId,
        uint64 epoch,
        L2Deposit[] calldata deposits,
        address[] calldata signers,
        bytes[] calldata sigs
    ) external returns (uint256 batchId);

    // ------------------------------------------------------------------ canonical checkpoints [P0]
    /// @notice Only the hub adapter of srcChainId. payload = abi.encode(Checkpoint). Stores only.
    function receiveCheckpoint(uint64 srcChainId, bytes calldata payload) external;
    /// @notice Anyone; chunked through maxItems.
    function processCheckpoint(uint64 srcChainId, uint64 seq, bytes calldata payload, uint256 maxItems) external;

    // ------------------------------------------------------------------ fraud proofs [P0]
    function proveAbsence(
        uint64 srcChainId,
        uint64 seq,
        uint256 batchId,
        L2Deposit[] calldata batchDeposits,
        uint256 pos
    ) external;

    function proveEquivocation(
        uint64 srcChainId,
        address signer,
        uint64 epochA,
        L2Deposit[] calldata depA,
        bytes calldata sigA,
        uint256 posA,
        uint64 epochB,
        L2Deposit[] calldata depB,
        bytes calldata sigB,
        uint256 posB
    ) external;

    // ------------------------------------------------------------------ guardian (bounded)
    function setCaps(uint256 maxDeposit, uint256 maxFastDeposit, uint256 tvlCapEth, uint256 betaNum, uint256 betaDen)
        external;

    // ------------------------------------------------------------------ views
    /// @notice EIP-712 digest of DepositBatch(srcChainId, spoke, epoch, deposits) (PRD 5.9).
    function batchDigest(uint64 srcChainId, uint64 epoch, L2Deposit[] calldata deposits)
        external
        view
        returns (bytes32);
    function domainSeparator() external view returns (bytes32);
    function unconfirmedFastValue() external view returns (uint256);
    function inserted(uint64 chainId, uint64 index) external view returns (bool);
    function confirmed(uint64 chainId, uint64 index) external view returns (bool);
    function batchStatus(uint256 batchId) external view returns (BatchStatus);
    function batchSigners(uint256 batchId) external view returns (uint32[] memory ids);
    function batchCount() external view returns (uint256);
    function spokeOf(uint64 chainId) external view returns (address);
    function minDeposit() external view returns (uint256);
    function maxDeposit() external view returns (uint256);
    function maxFastDeposit() external view returns (uint256);
}
