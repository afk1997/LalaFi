// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPoseidonT3} from "../../../src/interfaces/IPoseidon.sol";
import {P, TREE_DEPTH} from "../../../src/libraries/Types.sol";

/// @notice Reference sparse Merkle tree (I11). Independent of MerkleTreeWithHistory: it stores
///         every node and recomputes the whole path for each leaf, with its own zero hashes
///         computed from keccak256("xpool.v1.zero") and PoseidonT3.
contract RefMerkle {
    IPoseidonT3 public immutable h;
    uint256[TREE_DEPTH + 1] public z;
    mapping(uint256 level => mapping(uint256 index => uint256)) internal _node;
    mapping(uint256 level => mapping(uint256 index => bool)) internal _set;
    uint256 public count;
    uint256 public root;
    uint256[] public roots; // roots[k] = root after k-th pair (roots[0] = empty root)

    constructor(address poseidon) {
        h = IPoseidonT3(poseidon);
        z[0] = uint256(keccak256("xpool.v1.zero")) % P;
        for (uint256 i = 1; i <= TREE_DEPTH; ++i) {
            z[i] = h.hash([z[i - 1], z[i - 1]]);
        }
        root = z[TREE_DEPTH];
        roots.push(root);
    }

    function zeros() external view returns (uint256[TREE_DEPTH + 1] memory) {
        return z;
    }

    function _get(uint256 lvl, uint256 i) internal view returns (uint256) {
        return _set[lvl][i] ? _node[lvl][i] : z[lvl];
    }

    function _insert(uint256 leaf) internal {
        uint256 i = count++;
        _node[0][i] = leaf;
        _set[0][i] = true;
        for (uint256 lvl; lvl < TREE_DEPTH; ++lvl) {
            uint256 parent = i >> 1;
            uint256 l = _get(lvl, parent << 1);
            uint256 r = _get(lvl, (parent << 1) | 1);
            _node[lvl + 1][parent] = h.hash([l, r]);
            _set[lvl + 1][parent] = true;
            i = parent;
        }
        root = _node[TREE_DEPTH][0];
    }

    function insertPair(uint256 l, uint256 r) external {
        _insert(l);
        _insert(r);
        roots.push(root);
    }

    function rootCount() external view returns (uint256) {
        return roots.length;
    }

    /// @notice Naive root from scratch: hashes level by level, padding with zero subtrees.
    function naiveRoot(uint256[] memory leaves) external view returns (uint256) {
        uint256[] memory cur = leaves;
        for (uint256 lvl; lvl < TREE_DEPTH; ++lvl) {
            uint256 n = (cur.length + 1) / 2;
            uint256[] memory next = new uint256[](n);
            for (uint256 k; k < n; ++k) {
                uint256 l = cur[2 * k];
                uint256 r = 2 * k + 1 < cur.length ? cur[2 * k + 1] : z[lvl];
                next[k] = h.hash([l, r]);
            }
            cur = next;
            if (cur.length == 0) return z[TREE_DEPTH];
        }
        return cur[0];
    }
}
