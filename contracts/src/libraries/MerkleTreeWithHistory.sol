// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TREE_DEPTH, ROOT_HISTORY} from "./Types.sol";
import {ZeroHashes} from "./ZeroHashes.sol";
import {IHubCore} from "../interfaces/IHubCore.sol";

/// @title Incremental Merkle tree, depth 24, pair-only insertion, 100-root history (PRD 5.6).
/// @notice Node hash is PoseidonT3 (circomlib Poseidon(2)) reached by STATICCALL to the deployed
///         poseidon-solidity library. Every insertion appends exactly two leaves, so `nextIndex`
///         is always even and an insertion costs exactly 24 Poseidon calls.
/// @dev Frontier optimisation (same roots as the PRD pseudo-code): F[lvl] is only ever read as the
///      *final* value of a complete left subtree, so it is written only when the subtree rooted at
///      `cur` has just become complete. That is one SSTORE per insertion on average instead of ~12.
///      Root history: roots get a strictly increasing sequence number `seq`; rootSeq[root] holds the
///      latest seq at which `root` was the current root. A root is known iff 0 < rootSeq[root] and
///      currentSeq - rootSeq[root] < ROOT_HISTORY. Root 0 is never known.
abstract contract MerkleTreeWithHistory {
    error PoseidonFailed();

    /// @dev cast sig "hash(uint256[2])" == IPoseidonT3.hash.selector (checked in tests).
    uint256 private constant _HASH2_SELECTOR = 0x561558fe;
    uint256 private constant _CAPACITY = 1 << TREE_DEPTH;

    /// @notice poseidon-solidity PoseidonT3 library address.
    address public immutable poseidonT3;

    uint32 internal _nextIndex;
    uint64 internal _rootSeqCounter;
    /// @dev _frontier[lvl] = last complete left node at level lvl (lvl in 1..TREE_DEPTH-1; [0] unused).
    uint256[TREE_DEPTH] internal _frontier;
    uint256[ROOT_HISTORY] internal _roots;
    mapping(uint256 root => uint256 seq) internal _rootSeq;

    constructor(address poseidonT3_) {
        if (poseidonT3_.code.length == 0) revert PoseidonFailed();
        poseidonT3 = poseidonT3_;
        uint256 empty = ZeroHashes.Z24;
        _rootSeqCounter = 1;
        _roots[1 % ROOT_HISTORY] = empty;
        _rootSeq[empty] = 1;
    }

    // ------------------------------------------------------------------ views

    /// @notice Sequence number of the current root (1 = empty tree).
    function currentRootSeq() external view returns (uint64) {
        return _rootSeqCounter;
    }

    /// @notice Root with sequence number `seq`, if still inside the history window (else 0).
    function rootAt(uint64 seq) external view returns (uint256) {
        uint64 cur = _rootSeqCounter;
        if (seq == 0 || seq > cur || cur - seq >= ROOT_HISTORY) return 0;
        return _roots[uint256(seq) % ROOT_HISTORY];
    }

    // ------------------------------------------------------------------ internal

    /// @dev True iff `root` is one of the last ROOT_HISTORY roots. Root 0 is never known.
    function _isKnownRoot(uint256 root) internal view returns (bool) {
        if (root == 0) return false;
        uint256 s = _rootSeq[root];
        return s != 0 && uint256(_rootSeqCounter) - s < ROOT_HISTORY;
    }

    function _lastRoot() internal view returns (uint256) {
        return _roots[uint256(_rootSeqCounter) % ROOT_HISTORY];
    }

    /// @notice Appends (l, r) at leaf indices (nextIndex, nextIndex + 1). Returns the index of l.
    function _insertPair(uint256 l, uint256 r) internal returns (uint32 index) {
        uint32 next = _nextIndex;
        if (uint256(next) + 2 > _CAPACITY) revert IHubCore.TreeFull();

        uint256 idx = uint256(next) >> 1; // index of the pair's parent at level 1
        uint256 cur = _hash2(l, r);
        bool complete = true; // the subtree rooted at `cur` is full
        for (uint256 lvl = 1; lvl < TREE_DEPTH; ++lvl) {
            if (idx & 1 == 0) {
                if (complete) _frontier[lvl] = cur;
                cur = _hash2(cur, ZeroHashes.zeros(lvl));
                complete = false;
            } else {
                cur = _hash2(_frontier[lvl], cur);
            }
            idx >>= 1;
        }

        uint64 seq = _rootSeqCounter + 1;
        _rootSeqCounter = seq;
        _roots[uint256(seq) % ROOT_HISTORY] = cur;
        _rootSeq[cur] = seq;
        _nextIndex = next + 2;
        return next;
    }

    /// @dev H2(a, b) through STATICCALL to PoseidonT3.hash(uint256[2]).
    function _hash2(uint256 a, uint256 b) internal view returns (uint256 h) {
        address p = poseidonT3;
        bool ok;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, shl(224, _HASH2_SELECTOR))
            mstore(add(m, 0x04), a)
            mstore(add(m, 0x24), b)
            ok := staticcall(gas(), p, m, 0x44, m, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            h := mload(m)
        }
        if (!ok) revert PoseidonFailed();
    }
}
