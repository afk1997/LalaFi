/**
 * Struct definitions from contracts/src/libraries/Types.sol, as viem human-readable ABI fragments.
 * Field order MUST match Types.sol exactly.
 */
export const STRUCTS = [
  'struct Proof { uint256[2] a; uint256[2][2] b; uint256[2] c; }',
  'struct PublicInputs { uint256 root; uint256 publicAmount; uint256 extDataHash; uint256[2] inputNullifiers; uint256[2] outputCommitments; }',
  'struct ExtData { uint32 version; uint64 hubChainId; address hub; uint64 dstChainId; address recipient; uint256 withdrawAmount; address relayer; uint256 relayerFee; uint256 protocolFee; uint64 deadline; bytes encOut0; bytes encOut1; }',
  'struct Release { uint64 dstChainId; uint64 index; address recipient; uint256 amount; bytes32 spendId; }',
  'struct L2Deposit { uint64 index; uint256 ownerDigest; uint256 amount; uint256 fee; uint64 l2Block; }',
  'struct BridgeParams { uint256 maxSubmissionCost; uint256 gasLimit; uint256 maxFeePerGas; address refundAddress; }',
  'struct StoredDeposit { uint256 ownerDigest; uint256 amount; uint256 fee; uint64 l2Block; }',
] as const;

/** ExtData tuple components in Types.sol order (used for abi.encode / extDataHash). */
export const EXT_DATA_COMPONENTS = [
  { name: 'version', type: 'uint32' },
  { name: 'hubChainId', type: 'uint64' },
  { name: 'hub', type: 'address' },
  { name: 'dstChainId', type: 'uint64' },
  { name: 'recipient', type: 'address' },
  { name: 'withdrawAmount', type: 'uint256' },
  { name: 'relayer', type: 'address' },
  { name: 'relayerFee', type: 'uint256' },
  { name: 'protocolFee', type: 'uint256' },
  { name: 'deadline', type: 'uint64' },
  { name: 'encOut0', type: 'bytes' },
  { name: 'encOut1', type: 'bytes' },
] as const;
