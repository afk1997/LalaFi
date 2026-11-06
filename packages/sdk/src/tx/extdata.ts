/**
 * ExtData (PRD 5.7 / Types.sol) and extDataHash = uint256(keccak256(abi.encode(ext))) % p.
 * abi.encode of the struct is a single dynamic tuple (leading 0x20 offset word).
 */
import { encodeAbiParameters, getAddress, isAddress, isHex, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { EXT_DATA_COMPONENTS } from '../abi/structs.js';
import { EXT_DATA_VERSION, MAX_ENC_LEN } from '../constants.js';
import { mod, type Field } from '../crypto/field.js';

export interface ExtData {
  version: number;
  hubChainId: bigint;
  hub: Address;
  dstChainId: bigint;
  recipient: Address;
  withdrawAmount: bigint;
  relayer: Address;
  relayerFee: bigint;
  protocolFee: bigint;
  deadline: bigint;
  encOut0: Hex;
  encOut1: Hex;
}

const U64 = (1n << 64n) - 1n;
const U256 = (1n << 256n) - 1n;

export class ExtDataError extends Error {
  override name = 'ExtDataError';
}

function u(x: bigint, max: bigint, what: string): void {
  if (typeof x !== 'bigint' || x < 0n || x > max) throw new ExtDataError(`${what} out of range`);
}

/** Structural validation (types, ranges, lengths, withdrawal shape). */
export function validateExtData(e: ExtData): void {
  if (!Number.isInteger(e.version) || e.version < 0 || e.version > 0xffffffff) throw new ExtDataError('version out of range');
  u(e.hubChainId, U64, 'hubChainId');
  u(e.dstChainId, U64, 'dstChainId');
  u(e.deadline, U64, 'deadline');
  u(e.withdrawAmount, U256, 'withdrawAmount');
  u(e.relayerFee, U256, 'relayerFee');
  u(e.protocolFee, U256, 'protocolFee');
  for (const [k, a] of [['hub', e.hub], ['recipient', e.recipient], ['relayer', e.relayer]] as const) {
    if (!isAddress(a, { strict: false })) throw new ExtDataError(`${k} is not an address`);
  }
  for (const [k, b] of [['encOut0', e.encOut0], ['encOut1', e.encOut1]] as const) {
    if (!isHex(b, { strict: true }) || b.length % 2 !== 0) throw new ExtDataError(`${k} is not hex bytes`);
    if ((b.length - 2) / 2 > MAX_ENC_LEN) throw new ExtDataError(`${k} longer than ${MAX_ENC_LEN} bytes`);
  }
  const noWithdraw = e.dstChainId === 0n;
  if (noWithdraw) {
    if (getAddress(e.recipient) !== zeroAddress || e.withdrawAmount !== 0n || e.protocolFee !== 0n) {
      throw new ExtDataError('dstChainId = 0 requires recipient = 0, w = 0, protocolFee = 0');
    }
  } else if (getAddress(e.recipient) === zeroAddress) {
    throw new ExtDataError('withdrawal requires a non-zero recipient');
  }
  if (e.relayerFee > 0n && getAddress(e.relayer) === zeroAddress) throw new ExtDataError('relayerFee > 0 requires a relayer');
}

/** abi.encode(ExtData) exactly as Solidity does for a dynamic struct. */
export function encodeExtData(e: ExtData): Hex {
  validateExtData(e);
  return encodeAbiParameters(
    [{ type: 'tuple', components: EXT_DATA_COMPONENTS }],
    [
      {
        version: e.version,
        hubChainId: e.hubChainId,
        hub: getAddress(e.hub),
        dstChainId: e.dstChainId,
        recipient: getAddress(e.recipient),
        withdrawAmount: e.withdrawAmount,
        relayer: getAddress(e.relayer),
        relayerFee: e.relayerFee,
        protocolFee: e.protocolFee,
        deadline: e.deadline,
        encOut0: e.encOut0,
        encOut1: e.encOut1,
      },
    ],
  );
}

export function extDataHash(e: ExtData): Field {
  return mod(BigInt(keccak256(encodeExtData(e))));
}

/** ExtData with defaults for a version-1 spend. */
export function makeExtData(fields: Omit<ExtData, 'version'> & { version?: number }): ExtData {
  return { version: EXT_DATA_VERSION, ...fields };
}
