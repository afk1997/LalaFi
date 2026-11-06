// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {MerkleTreeWithHistory} from "../../src/libraries/MerkleTreeWithHistory.sol";
import {ZeroHashes} from "../../src/libraries/ZeroHashes.sol";
import {Field} from "../../src/libraries/Field.sol";
import {IPoseidonT3} from "../../src/interfaces/IPoseidon.sol";
import {IHubCore} from "../../src/interfaces/IHubCore.sol";
import {P, TREE_DEPTH, ROOT_HISTORY} from "../../src/libraries/Types.sol";
import {RefMerkle} from "./utils/RefMerkle.sol";

contract TreeHarness is MerkleTreeWithHistory {
    constructor(address p) MerkleTreeWithHistory(p) {}

    function insertPair(uint256 l, uint256 r) external returns (uint32) {
        return _insertPair(l, r);
    }

    function hash2(uint256 a, uint256 b) external view returns (uint256) {
        return _hash2(a, b);
    }

    function isKnownRoot(uint256 root) external view returns (bool) {
        return _isKnownRoot(root);
    }

    function lastRoot() external view returns (uint256) {
        return _lastRoot();
    }

    function setNextIndex(uint32 n) external {
        _nextIndex = n;
    }
}

contract FieldHarness {
    function requireField(uint256 x) external pure {
        Field.requireField(x);
    }

    function neg(uint256 x) external pure returns (uint256) {
        return Field.neg(x);
    }

    function zeros(uint256 i) external pure returns (uint256) {
        return ZeroHashes.zeros(i);
    }
}

contract MerkleTreeTest is Test {
    address internal poseidon;
    IPoseidonT3 internal h;
    TreeHarness internal tree;
    RefMerkle internal ref;
    FieldHarness internal fh;

    function setUp() public {
        poseidon = deployCode("PoseidonT3.sol:PoseidonT3");
        h = IPoseidonT3(poseidon);
        tree = new TreeHarness(poseidon);
        ref = new RefMerkle(poseidon);
        fh = new FieldHarness();
    }

    // ------------------------------------------------------------------ zero hashes

    function test_zeroHashes_matchPoseidon() public view {
        uint256 z = uint256(keccak256("xpool.v1.zero")) % P;
        assertEq(ZeroHashes.Z0, z);
        for (uint256 i; i <= TREE_DEPTH; ++i) {
            assertEq(fh.zeros(i), z, "Z[i]");
            z = h.hash([z, z]);
        }
        assertEq(fh.zeros(24), ZeroHashes.Z24);
        uint256[TREE_DEPTH + 1] memory rz = ref.zeros();
        for (uint256 i; i <= TREE_DEPTH; ++i) {
            assertEq(rz[i], fh.zeros(i));
        }
    }

    function test_zeroHashes_outOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(ZeroHashes.ZeroIndexOutOfRange.selector, uint256(25)));
        fh.zeros(25);
    }

    function test_hashSelector() public view {
        assertEq(uint32(IPoseidonT3.hash.selector), uint32(0x561558fe));
        assertEq(tree.hash2(1, 2), h.hash([uint256(1), uint256(2)]));
        // circomlib Poseidon([1,2]) reference vector
        assertEq(tree.hash2(1, 2), 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a);
    }

    function test_constructor_rejectsPoseidonWithoutCode() public {
        vm.expectRevert(MerkleTreeWithHistory.PoseidonFailed.selector);
        new TreeHarness(address(0x1234));
    }

    // ------------------------------------------------------------------ field

    function test_field() public {
        fh.requireField(P - 1);
        vm.expectRevert(Field.FieldOverflow.selector);
        fh.requireField(P);
        assertEq(fh.neg(0), 0);
        assertEq(fh.neg(1), P - 1);
        assertEq(fh.neg(P - 1), 1);
        vm.expectRevert(Field.FieldOverflow.selector);
        fh.neg(P);
        assertEq(Field.FieldOverflow.selector, IHubCore.FieldOverflow.selector);
    }

    // ------------------------------------------------------------------ tree vs reference (I11)

    function test_emptyRoot() public view {
        assertEq(tree.lastRoot(), ZeroHashes.Z24);
        assertEq(ref.root(), ZeroHashes.Z24);
        assertTrue(tree.isKnownRoot(ZeroHashes.Z24));
        assertFalse(tree.isKnownRoot(0));
        assertEq(tree.currentRootSeq(), 1);
        assertEq(tree.rootAt(1), ZeroHashes.Z24);
    }

    function testFuzz_matchesReference(uint256 seed, uint8 nPairs) public {
        uint256 n = bound(nPairs, 1, 40);
        uint256[] memory leaves = new uint256[](2 * n);
        for (uint256 i; i < n; ++i) {
            uint256 l = uint256(keccak256(abi.encode(seed, i, 0))) % P;
            uint256 r = uint256(keccak256(abi.encode(seed, i, 1))) % P;
            leaves[2 * i] = l;
            leaves[2 * i + 1] = r;
            assertEq(tree.insertPair(l, r), 2 * i);
            ref.insertPair(l, r);
            assertEq(tree.lastRoot(), ref.root(), "root mismatch");
            assertTrue(tree.isKnownRoot(ref.root()));
        }
        assertEq(tree.lastRoot(), ref.naiveRoot(leaves), "naive mismatch");
        assertEq(tree.insertPair(0, 0), 2 * n); // next index advanced by exactly 2 per pair
    }

    function test_matchesReference_acrossSubtreeBoundaries() public {
        // 2^7 pairs = 256 leaves: crosses every frontier level up to 8 at least once.
        for (uint256 i; i < 128; ++i) {
            uint256 l = uint256(keccak256(abi.encode("l", i))) % P;
            uint256 r = uint256(keccak256(abi.encode("r", i))) % P;
            tree.insertPair(l, r);
            ref.insertPair(l, r);
            assertEq(tree.lastRoot(), ref.root());
        }
    }

    function test_rootHistory_window() public {
        uint256[] memory roots = new uint256[](ROOT_HISTORY + 1);
        roots[0] = tree.lastRoot();
        for (uint256 i = 1; i <= ROOT_HISTORY; ++i) {
            tree.insertPair(i, i + 1000);
            roots[i] = tree.lastRoot();
        }
        // current seq = 101; roots with seq 2..101 (indices 1..100) are known, seq 1 (empty) is not.
        assertFalse(tree.isKnownRoot(roots[0]));
        for (uint256 i = 1; i <= ROOT_HISTORY; ++i) {
            assertTrue(tree.isKnownRoot(roots[i]));
        }
        assertEq(tree.rootAt(1), 0);
        assertEq(tree.rootAt(2), roots[1]);
        assertEq(tree.rootAt(101), roots[100]);
        assertEq(tree.rootAt(102), 0);
        assertEq(tree.rootAt(0), 0);
        tree.insertPair(7, 8);
        assertFalse(tree.isKnownRoot(roots[1]));
        assertTrue(tree.isKnownRoot(roots[2]));
    }

    function test_treeFull() public {
        tree.setNextIndex(uint32((1 << TREE_DEPTH) - 2));
        assertEq(tree.insertPair(1, 2), (1 << TREE_DEPTH) - 2);
        vm.expectRevert(IHubCore.TreeFull.selector);
        tree.insertPair(3, 4);
    }

    function test_pairInsertGas() public {
        tree.insertPair(1, 2);
        uint256 g = gasleft();
        tree.insertPair(3, 4);
        emit log_named_uint("insertPair gas (warm)", g - gasleft());
        g = gasleft();
        tree.hash2(5, 6);
        emit log_named_uint("single H2 via harness", g - gasleft());
        g = gasleft();
        h.hash([uint256(5), uint256(6)]);
        emit log_named_uint("single H2 direct", g - gasleft());
    }
}
