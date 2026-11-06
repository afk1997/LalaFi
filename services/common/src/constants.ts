import type { Address } from 'viem';

/** BN254 scalar field modulus (Types.sol `P`). Public inputs and field elements are < P. */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BN254 base field modulus. Groth16 proof coordinates (G1/G2) are < Q. */
export const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export const TOKEN_ID = 1n;
export const MAX_ENC_LEN = 256;
export const MAX_BATCH = 32;
export const MAX_VALIDATORS = 32;
export const AMOUNT_BOUND = 1n << 248n;
export const EXT_DATA_VERSION = 1;

export const MSG_RELEASE = 1;
export const MSG_REBALANCE = 2;
export const MSG_PAUSE = 3;
export const MSG_CHECKPOINT = 4;

export const FRAUD_MISMATCH = 1;
export const FRAUD_ABSENCE = 2;
export const FRAUD_EQUIVOCATION = 3;

/** Arbitrum precompiles. */
export const ARB_SYS: Address = '0x0000000000000000000000000000000000000064';
export const NODE_INTERFACE: Address = '0x00000000000000000000000000000000000000C8';
/** AddressAliasHelper offset. */
export const ARB_ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;

/** OP Stack L2 messenger predeploy. */
export const OP_L2_MESSENGER: Address = '0x4200000000000000000000000000000000000007';

/** CCTP V2 finality thresholds. */
export const CCTP_FINALITY_FAST = 1000;
export const CCTP_FINALITY_STANDARD = 2000;

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
