import { parseAbi } from 'viem';

/**
 * Human-readable ABIs derived by hand from contracts/src/interfaces/*.sol.
 * This is the ONLY module that defines protocol ABIs for the services.
 * TODO(xpool): replace with forge-generated JSON (contracts/out) once the contracts land.
 */

const STRUCTS = [
  'struct Proof { uint256[2] a; uint256[2][2] b; uint256[2] c; }',
  'struct PublicInputs { uint256 root; uint256 publicAmount; uint256 extDataHash; uint256[2] inputNullifiers; uint256[2] outputCommitments; }',
  'struct ExtData { uint32 version; uint64 hubChainId; address hub; uint64 dstChainId; address recipient; uint256 withdrawAmount; address relayer; uint256 relayerFee; uint256 protocolFee; uint64 deadline; bytes encOut0; bytes encOut1; }',
  'struct Release { uint64 dstChainId; uint64 index; address recipient; uint256 amount; bytes32 spendId; }',
  'struct L2Deposit { uint64 index; uint256 ownerDigest; uint256 amount; uint256 fee; uint64 l2Block; }',
  'struct BridgeParams { uint256 maxSubmissionCost; uint256 gasLimit; uint256 maxFeePerGas; address refundAddress; }',
  'struct StoredDeposit { uint256 ownerDigest; uint256 amount; uint256 fee; uint64 l2Block; }',
] as const;

// ---------------------------------------------------------------------------- IHubCore
export const hubCoreAbi = parseAbi([
  ...STRUCTS,
  'error SpendsPaused(uint64 until)',
  'error BadVersion()',
  'error BadHubChain()',
  'error BadHub()',
  'error Expired()',
  'error EncOutTooLong()',
  'error BadWithdrawShape()',
  'error UnsupportedChain(uint64 chainId)',
  'error BelowMinWithdraw()',
  'error BadProtocolFee()',
  'error BadRelayerFee()',
  'error AmountTooLarge()',
  'error BadPublicAmount()',
  'error UnknownRoot()',
  'error FieldOverflow()',
  'error DuplicateNullifier()',
  'error NullifierSpent(uint256 nullifier)',
  'error BadExtDataHash()',
  'error InvalidProof()',
  'error UnexpectedValue()',
  'error TreeFull()',
  'error OnlyDepositManager()',
  'error OnlyGuardian()',
  'error UnknownRelease()',
  'error EmergencyCooldown()',
  'error InsufficientLiquidity(uint64 chainId)',
  'error InsufficientValue()',
  'event NewCommitment(uint256 indexed commitment, uint32 indexed leafIndex, bytes encryptedOutput)',
  'event NewNullifier(uint256 indexed nullifier)',
  'event Spend(bytes32 indexed spendId, uint256 root, uint64 dstChainId, uint256 v)',
  'event ReleaseLogged(uint64 indexed dstChainId, uint64 indexed index, address recipient, uint256 amount, bytes32 spendId)',
  'event ReleaseResent(uint64 indexed dstChainId, uint64 indexed index)',
  'event LeavesInserted(uint32 indexed firstLeafIndex, uint256 count, uint256 newRoot)',
  'function transact(Proof proof, PublicInputs pi, ExtData ext, BridgeParams bp) payable',
  'function resendRelease(Release r, BridgeParams bp) payable',
  'function isKnownRoot(uint256 root) view returns (bool)',
  'function getLastRoot() view returns (uint256)',
  'function isSpent(uint256 nullifier) view returns (bool)',
  'function nextLeafIndex() view returns (uint32)',
  'function shieldedSupply() view returns (uint256)',
  'function releaseCount(uint64 dstChainId) view returns (uint64)',
  'function releaseHash(uint64 dstChainId, uint64 index) view returns (bytes32)',
  'function spendsPausedUntil() view returns (uint64)',
  'function isSupportedChain(uint64 chainId) view returns (bool)',
  'function adapterFor(uint64 chainId) view returns (address)',
  'function phiBps() view returns (uint256)',
  'function relayerFeeBucket() view returns (uint256)',
  'function minWithdraw(uint64 dstChainId) view returns (uint256)',
  'function guardian() view returns (address)',
  'function inflowsPaused() view returns (bool)',
]);

// ---------------------------------------------------------------------------- IDepositManager
export const depositManagerAbi = parseAbi([
  ...STRUCTS,
  'error InflowsPaused()',
  'error BadEpoch()',
  'error BadBatchSize()',
  'error AlreadyInserted(uint64 chainId, uint64 index)',
  'error SignersNotAscending()',
  'error LengthMismatch()',
  'error InvalidSigner(address signer)',
  'error BadSignature(address signer)',
  'error QuorumR1()',
  'error QuorumR2()',
  'error QuorumR3(address signer)',
  'error SafetyValve()',
  'error BadCheckpoint()',
  'error DuplicateCheckpoint()',
  'error UnknownCheckpoint()',
  'error PayloadMismatch()',
  'error UnknownBatch()',
  'error BatchDataMismatch()',
  'error NotFraud()',
  'error OutOfBounds()',
  'error UnsupportedChain(uint64 chainId)',
  'error BadAmount()',
  'error FieldOverflow()',
  'event BatchAttested(uint256 indexed batchId, uint64 indexed srcChainId, uint64 epoch, uint256 totalAmount, uint256 signerBitmap, address submitter)',
  'event L2DepositInserted(uint64 indexed srcChainId, uint64 indexed index, uint256 commitment, uint32 leafIndex, bool fastLane)',
  'event CheckpointReceived(uint64 indexed srcChainId, uint64 indexed seq, uint64 from, uint64 to, uint64 countAtSend, uint64 l2Block)',
  'event CheckpointProcessed(uint64 indexed srcChainId, uint64 indexed seq, uint64 nextItem, bool done)',
  'event DepositConfirmed(uint64 indexed srcChainId, uint64 indexed index)',
  'event BatchConfirmed(uint256 indexed batchId)',
  'event FraudProven(uint256 indexed batchId, uint8 kind, address prover)',
  'function submitAttestation(uint64 srcChainId, uint64 epoch, L2Deposit[] deposits, address[] signers, bytes[] sigs) returns (uint256 batchId)',
  'function processCheckpoint(uint64 srcChainId, uint64 seq, bytes payload, uint256 maxItems)',
  'function proveAbsence(uint64 srcChainId, uint64 seq, uint256 batchId, L2Deposit[] batchDeposits, uint256 pos)',
  'function proveEquivocation(uint64 srcChainId, address signer, uint64 epochA, L2Deposit[] depA, bytes sigA, uint256 posA, uint64 epochB, L2Deposit[] depB, bytes sigB, uint256 posB)',
  'function batchDigest(uint64 srcChainId, uint64 epoch, L2Deposit[] deposits) view returns (bytes32)',
  'function domainSeparator() view returns (bytes32)',
  'function unconfirmedFastValue() view returns (uint256)',
  'function inserted(uint64 chainId, uint64 index) view returns (bool)',
  'function confirmed(uint64 chainId, uint64 index) view returns (bool)',
  'function batchStatus(uint256 batchId) view returns (uint8)',
  'function batchSigners(uint256 batchId) view returns (uint32[] ids)',
  'function batchCount() view returns (uint256)',
  'function spokeOf(uint64 chainId) view returns (address)',
  'function minDeposit() view returns (uint256)',
  'function maxDeposit() view returns (uint256)',
  'function maxFastDeposit() view returns (uint256)',
]);

// ---------------------------------------------------------------------------- IStakeManager
export const stakeManagerAbi = parseAbi([
  'error AlreadyRegistered()',
  'error NotRegistered()',
  'error Jailed()',
  'error EpochNotDue()',
  'error BelowMinBond()',
  'error OverAllocated()',
  'event Registered(uint32 indexed id, address operator, address signer)',
  'event EpochAdvanced(uint64 indexed epoch)',
  'event Slashed(uint32 indexed id, uint256 amount, uint8 reason, address prover, uint256 proverReward)',
  'function register(address signer)',
  'function bond(uint256 amount)',
  'function setAllocations(uint64[] chainIds, uint256[] amounts)',
  'function advanceEpoch()',
  'function currentEpoch() view returns (uint64)',
  'function epochStart(uint64 epoch) view returns (uint64)',
  'function allocation(uint32 id, uint64 chainId, uint64 epoch) view returns (uint256)',
  'function totalAllocation(uint64 chainId, uint64 epoch) view returns (uint256)',
  'function exposure(uint32 id, uint64 chainId) view returns (uint256)',
  'function validatorBySigner(address signer) view returns (uint32 id, bool active, bool jailed)',
  'function operatorOf(uint32 id) view returns (address)',
  'function signerOf(uint32 id) view returns (address)',
  'function bondedOf(uint32 id) view returns (uint256)',
  'function activeValidators() view returns (uint32[])',
  'function sMin() view returns (uint256)',
  'function k() view returns (uint256 kNum, uint256 kDen)',
  'function theta() view returns (uint256 thetaNum, uint256 thetaDen)',
]);

// ---------------------------------------------------------------------------- ILiquidityManager
export const liquidityManagerAbi = parseAbi([
  ...STRUCTS,
  'error InsufficientLiquidity(uint64 chainId)',
  'error RebalancePolicy()',
  'error InflowsPaused()',
  'error ZeroAmount()',
  'event Rebalanced(uint64 indexed srcChainId, uint64 indexed dstChainId, uint256 amount, uint256 maxFee, uint64 nonce)',
  'function rebalance(uint64 srcChainId, uint64 dstChainId, uint256 amount, BridgeParams bp) payable',
  'function available(uint64 chainId) view returns (uint256)',
  'function lpAssets() view returns (uint256)',
  'function insurance() view returns (uint256)',
  'function target(uint64 chainId) view returns (uint256)',
  'function targetBps(uint64 chainId) view returns (uint256)',
  'function rebalanceNonce() view returns (uint64)',
]);

// ---------------------------------------------------------------------------- IHubAdapter
export const hubAdapterAbi = parseAbi([
  'function spoke() view returns (address)',
  'function spokeChainId() view returns (uint64)',
]);

// ---------------------------------------------------------------------------- ISpoke
export const spokeAbi = parseAbi([
  ...STRUCTS,
  'error DepositsPaused()',
  'error EmptyCheckpointTooSoon()',
  'error NotFailed()',
  'error NotFromHub()',
  'event Deposit(uint64 indexed index, uint256 ownerDigest, uint256 amount, uint256 fee, uint64 l2Block, bytes encNote)',
  'event CheckpointSent(uint64 indexed seq, uint64 from, uint64 to, uint64 countAtSend, uint64 l2Block)',
  'event ReleaseExecuted(uint64 indexed index, address recipient, uint256 amount)',
  'event ReleaseQueued(uint64 indexed index)',
  'event ReleaseFailed(uint64 indexed index)',
  'event RebalanceBurn(uint64 indexed nonce, uint256 amount, uint32 dstDomain, bytes32 mintRecipient)',
  'event HubMessageIgnored(uint8 kind, bytes reason)',
  'function sendCheckpoint()',
  'function receiveFromHub(bytes message)',
  'function processQueue(uint256 maxItems)',
  'function retryFailedRelease(uint64 index)',
  'function hubChainId() view returns (uint64)',
  'function hubAdapter() view returns (address)',
  'function usdc() view returns (address)',
  'function depositCount() view returns (uint64)',
  'function nextCheckpointFrom() view returns (uint64)',
  'function checkpointSeq() view returns (uint64)',
  'function getDeposit(uint64 index) view returns (StoredDeposit)',
  'function releaseState(uint64 index) view returns (uint8)',
  'function queueLength() view returns (uint256)',
  'function depositsPaused() view returns (bool)',
  'function l2BlockNumber() view returns (uint64)',
]);

// ---------------------------------------------------------------------------- ERC-20 (USDC / MockUSDC)
export const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);

// ---------------------------------------------------------------------------- Arbitrum (real)
export const arbInboxAbi = parseAbi([
  'function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)',
]);

export const nodeInterfaceAbi = parseAbi([
  'function estimateRetryableTicket(address sender, uint256 deposit, address to, uint256 l2CallValue, address excessFeeRefundAddress, address callValueRefundAddress, bytes data)',
  'function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)',
]);

export const arbBridgeAbi = parseAbi([
  'function activeOutbox() view returns (address)',
  'function rollup() view returns (address)',
]);

export const arbOutboxAbi = parseAbi([
  'function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)',
  'function isSpent(uint256 index) view returns (bool)',
  'function roots(bytes32 root) view returns (bytes32)',
]);

/** BoLD rollup (Arbitrum Sepolia / One after the BoLD upgrade) and legacy rollup events. */
export const arbRollupAbi = parseAbi([
  'function latestConfirmed() view returns (bytes32)',
  'event AssertionConfirmed(bytes32 indexed assertionHash, bytes32 blockHash, bytes32 sendRoot)',
  'event NodeConfirmed(uint64 indexed nodeNum, bytes32 blockHash, bytes32 sendRoot)',
]);

export const arbSysAbi = parseAbi([
  'event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)',
]);

// ---------------------------------------------------------------------------- CCTP V2 (real)
export const messageTransmitterV2Abi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
]);

// ---------------------------------------------------------------------------- LOCAL mocks (IMocks.sol)
export const mockMessengerAbi = parseAbi([
  'event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)',
  'event RelayedMessage(bytes32 indexed msgHash)',
  'event FailedRelayedMessage(bytes32 indexed msgHash)',
  'function relayMessage(uint256 nonce, address sender, address target, bytes message, uint256 gasLimit)',
  'function relayer() view returns (address)',
]);

export const mockInboxAbi = parseAbi([
  'event RetryableCreated(uint256 indexed ticketId, address from, address to, uint256 l2CallValue, uint256 gasLimit, bytes data)',
  'function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)',
]);

export const mockArbSysAbi = parseAbi([
  'event L2ToL1Tx(address caller, address indexed destination, uint256 indexed position, bytes data)',
  'function arbBlockNumber() view returns (uint256)',
]);

export const mockOutboxAbi = parseAbi([
  'event OutBoxTransactionExecuted(address indexed to, address indexed l2Sender, uint256 indexed position)',
  'function executeTransaction(uint256 position, address l2Sender, address to, bytes data)',
  'function relayer() view returns (address)',
]);

export const mockTokenMessengerAbi = parseAbi([
  'event MessageSent(bytes message)',
  'event DepositForBurn(uint64 indexed nonce, address burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, uint256 maxFee, uint32 minFinalityThreshold)',
  'function localDomain() view returns (uint32)',
]);

export const mockMessageTransmitterAbi = parseAbi([
  'event MintAndWithdraw(address indexed mintRecipient, uint256 amount, uint64 indexed nonce, uint32 srcDomain)',
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function attester() view returns (address)',
  'function usedNonce(uint32 srcDomain, uint64 nonce) view returns (bool)',
]);
