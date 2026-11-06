/**
 * Protocol constants. MUST match contracts/src/libraries/Types.sol.
 */

/** BN254 scalar field modulus. */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Token id inside the note commitment (USDC = 1 in v1, circuit constant). */
export const TOKEN_ID = 1n;

/** Merkle tree depth (PRD 5.6). */
export const TREE_DEPTH = 24;

/** Maximum number of leaves (2^24). */
export const MAX_LEAVES = 2 ** TREE_DEPTH;

/** Root history size (PRD 5.6). */
export const ROOT_HISTORY = 100;

/** Maximum length of any encrypted note blob. */
export const MAX_ENC_LEN = 256;

/** Every amount and v must be < 2^248 (PRD 5.11). */
export const AMOUNT_BOUND = 1n << 248n;

/** ExtData.version (PRD 5.7). */
export const EXT_DATA_VERSION = 1;

/** USDC decimals. */
export const USDC_DECIMALS = 6;

/** BIP-44 path prefix for fresh withdrawal EOAs (PRD 5.3). */
export const FRESH_PATH_PREFIX = "m/44'/60'/7331'/0";

/** Domain seed of the zero leaf (PRD 5.6). */
export const ZERO_LEAF_SEED = 'xpool.v1.zero';
