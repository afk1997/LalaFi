// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// @title xpool shared types and constants (PRD Section 7.3)
// @notice Every contract, the SDK and the services MUST agree on these encodings.

// @dev BN254 scalar field modulus.
uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

// @dev Token id inside the note commitment. USDC = 1 in v1 (circuit constant).
uint256 constant TOKEN_ID = 1;

// @dev Merkle tree depth (PRD 5.6). 2^24 leaves.
uint256 constant TREE_DEPTH = 24;

// @dev Root history size (PRD 5.6).
uint256 constant ROOT_HISTORY = 100;

// @dev Maximum length of any encrypted note blob.
uint256 constant MAX_ENC_LEN = 256;

// @dev Max deposits per fast-lane batch (PRD 9.8).
uint256 constant MAX_BATCH = 32;

// @dev Max active validators (PRD 9.8).
uint256 constant MAX_VALIDATORS = 32;

// @dev Amount range bound (PRD 5.11): every amount and v must be < 2^248.
uint256 constant AMOUNT_BOUND = 1 << 248;

// @dev ExtData.version (PRD 5.7).
uint32 constant EXT_DATA_VERSION = 1;

// ---------------------------------------------------------------------------
// Cross-chain message kinds. Envelope: abi.encode(uint8 kind, bytes body)
// ---------------------------------------------------------------------------

// hub -> spoke: body = abi.encode(Release)
uint8 constant MSG_RELEASE = 1;
// hub -> spoke: body = abi.encode(RebalanceOrder)
uint8 constant MSG_REBALANCE = 2;
// hub -> spoke: body = abi.encode(bool depositsPaused)
uint8 constant MSG_PAUSE = 3;
// spoke -> hub: body = abi.encode(Checkpoint)
uint8 constant MSG_CHECKPOINT = 4;

// ---------------------------------------------------------------------------
// Fraud kinds (DepositManager.FraudProven.kind) and slash reasons
// ---------------------------------------------------------------------------

uint8 constant FRAUD_MISMATCH = 1;
uint8 constant FRAUD_ABSENCE = 2;
uint8 constant FRAUD_EQUIVOCATION = 3;

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

// @dev Groth16 proof as consumed by the snarkjs-generated verifier.
//      NOTE: `b` is in the verifier's expected order, i.e. the G2 coordinates
//      are already swapped the way `snarkjs zkey export soliditycalldata` emits them.
struct Proof {
    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
}

// @dev Public signals, in snarkjs order:
//      [root, publicAmount, extDataHash, inputNullifier[0], inputNullifier[1],
//       outputCommitment[0], outputCommitment[1]]
struct PublicInputs {
    uint256 root;
    uint256 publicAmount;
    uint256 extDataHash;
    uint256[2] inputNullifiers;
    uint256[2] outputCommitments;
}

// @dev Everything about a spend that lives outside the circuit (PRD 5.7).
//      extDataHash = uint256(keccak256(abi.encode(ext))) % P
//      abi.encode of this struct is a single dynamic tuple (leading 0x20 offset word);
//      the SDK reproduces it with viem encodeAbiParameters([{type:'tuple',...}], [ext]).
struct ExtData {
    uint32 version; // = 1
    uint64 hubChainId; // must equal block.chainid of the hub
    address hub; // must equal HubCore address
    uint64 dstChainId; // 0 = no withdrawal (transfer / merge / fee-only)
    address recipient; // must be 0 iff dstChainId == 0
    uint256 withdrawAmount; // w; must be 0 iff dstChainId == 0
    address relayer; // receives relayerFee on Ethereum
    uint256 relayerFee; // multiple of relayerFeeBucket
    uint256 protocolFee; // == ceilDiv(w * phiBps, 10_000)
    uint64 deadline; // unix seconds; spend invalid after this
    bytes encOut0; // <= 256 bytes
    bytes encOut1; // <= 256 bytes
}

// @dev A hub-logged instruction to pay `amount` to `recipient` on `dstChainId`.
//      releaseHash[dst][index] = keccak256(abi.encode(Release))
struct Release {
    uint64 dstChainId;
    uint64 index; // per-destination sequence, from 0
    address recipient;
    uint256 amount; // w
    bytes32 spendId; // keccak256(abi.encode(inputNullifiers[0], inputNullifiers[1]))
}

// @dev An L2 deposit as recorded by a spoke (PRD 7.3).
//      Item hash used everywhere (fast-lane items, checkpoints, fraud proofs):
//      keccak256(abi.encode(L2Deposit))
struct L2Deposit {
    uint64 index; // spoke deposit index
    uint256 ownerDigest; // P (< p)
    uint256 amount; // a
    uint256 fee; // settlement fee paid at deposit (insert + final)
    uint64 l2Block; // L2 block number of the deposit (ArbSys.arbBlockNumber on Arbitrum)
}

// @dev Relayer-chosen delivery parameters; NOT bound in the proof.
struct BridgeParams {
    uint256 maxSubmissionCost; // Arbitrum only
    uint256 gasLimit; // Arbitrum only
    uint256 maxFeePerGas; // Arbitrum only
    address refundAddress; // Arbitrum: L2 refund for excess ETH
}

// @dev Body of MSG_REBALANCE (hub -> source spoke): burn `amount` through CCTP V2.
struct RebalanceOrder {
    uint256 amount;
    uint32 dstDomain;
    bytes32 mintRecipient;
    uint256 maxFee;
    uint32 minFinality;
    uint64 nonce;
}

// @dev Body of MSG_CHECKPOINT (spoke -> hub).
//      Invariant enforced on receipt: to - from == deposits.length and deposits[k].index == from + k.
struct Checkpoint {
    uint64 seq;
    uint64 from;
    uint64 to;
    uint64 countAtSend;
    uint64 l2Block;
    L2Deposit[] deposits;
}
