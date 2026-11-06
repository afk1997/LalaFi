// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoseidonT3, IPoseidonT4} from "../../src/interfaces/IPoseidon.sol";
import {ZeroHashes} from "../../src/libraries/ZeroHashes.sol";

/// PRD 5.2 [P0]: Solidity Poseidon == circuit/circomlibjs Poseidon (fixtures from the circuits workstream).
contract CrossVectorsTest is Test {
    IPoseidonT3 t3;
    IPoseidonT4 t4;
    string json;

    function setUp() public {
        t3 = IPoseidonT3(deployCode("PoseidonT3.sol:PoseidonT3"));
        t4 = IPoseidonT4(deployCode("PoseidonT4.sol:PoseidonT4"));
        json = vm.readFile(string.concat(vm.projectRoot(), "/../fixtures/poseidon-columns.json"));
    }

    function _col(string memory key, string memory field) internal view returns (uint256[] memory) {
        return vm.parseJsonUintArray(json, string.concat(key, ".", field));
    }

    function test_H2_matches_circuit_vectors() public view {
        uint256[] memory a = _col(".H2", "in0");
        uint256[] memory b = _col(".H2", "in1");
        uint256[] memory o = _col(".H2", "output");
        assertGt(o.length, 1000);
        assertEq(a.length, o.length);
        for (uint256 i; i < o.length; i++) {
            assertEq(t3.hash([a[i], b[i]]), o[i]);
        }
    }

    function test_H3_matches_circuit_vectors() public view {
        uint256[] memory a = _col(".H3", "in0");
        uint256[] memory b = _col(".H3", "in1");
        uint256[] memory c = _col(".H3", "in2");
        uint256[] memory o = _col(".H3", "output");
        assertGt(o.length, 1000);
        assertEq(c.length, o.length);
        for (uint256 i; i < o.length; i++) {
            assertEq(t4.hash([a[i], b[i], c[i]]), o[i]);
        }
    }

    function test_zero_hashes_match_circuit() public view {
        string memory zj = vm.readFile(string.concat(vm.projectRoot(), "/../fixtures/circuit-zero-hashes.json"));
        string[] memory z = vm.parseJsonStringArray(zj, ".zeros");
        assertEq(z.length, 25);
        for (uint256 l; l < 25; l++) {
            assertEq(ZeroHashes.zeros(l), vm.parseUint(z[l]));
        }
    }
}
