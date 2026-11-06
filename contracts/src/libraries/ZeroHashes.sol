// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Zero subtree hashes of the global Merkle tree (PRD 5.6).
/// @notice Z0 = keccak256("xpool.v1.zero") mod p; Z[l+1] = PoseidonT3(Z[l], Z[l]); empty root = Z24.
///         Generated with the deployed poseidon-solidity PoseidonT3 bytecode and re-checked by
///         contracts/test/core/ZeroHashes.t.sol. Never edit by hand.
library ZeroHashes {
    error ZeroIndexOutOfRange(uint256 level);

    uint256 internal constant Z0 = 0x2e86b0702485135612272e2773be4322e3f527bb1679dfcb4062e003b72d9bb1;
    uint256 internal constant Z1 = 0x1ef6168053db80da4a7d421fc97050c971f67c3a51d9e2ab7a4257f734e54e34;
    uint256 internal constant Z2 = 0x29f44d59de36b403505a4df89ebe2d55f0c30709aa719a16c1d50becbfa6b7df;
    uint256 internal constant Z3 = 0x2aab8a81a6abe027dfa532e471ad7d1b2c271fce8b4b102618bdd1f43a9f9f57;
    uint256 internal constant Z4 = 0x0ed499a8b550f1298f7525fc1a4409f1fb4407c3413f6ac622289daa728af6e8;
    uint256 internal constant Z5 = 0x2b6d6fd201223c489bc243c3a60b3c8dc5d30a5d9a82c59a44485c7a81bf06df;
    uint256 internal constant Z6 = 0x2f57d0b42f5be44278af2f0018605665df3436d7f4800ea2540826ae4cbe724c;
    uint256 internal constant Z7 = 0x1ba48ff66e45cb4645c46ea6da7d5ab1948943c735f65b2ea9dde8fcd36bd16e;
    uint256 internal constant Z8 = 0x075fe759705d3ceb4650e86f8f6b31a661de5ac81aa59e85dc1f615448ad66cd;
    uint256 internal constant Z9 = 0x1605be221768e5f0de6cc5e430599126e4cdb9b260db599e62097786369ac71b;
    uint256 internal constant Z10 = 0x0b920df0d3571f48a8d631c189e68873527510be223e16b2a0905da23e790a9b;
    uint256 internal constant Z11 = 0x044b9c8aaad15b91e1b0ffa0ec959b6b19a05511e5c4f6848f609d55f013e8d6;
    uint256 internal constant Z12 = 0x0c2e63123235fb7cca491b849fb00db451a8b7d0504621624a260900d431246e;
    uint256 internal constant Z13 = 0x1eb54f3e211b26a8a351fcceefbafb504f502b1aa7de4d40812ff05459684183;
    uint256 internal constant Z14 = 0x140d32600364f919e2c35c79b6edf300d6cf07dfdc0e7d3de52d778aa5522057;
    uint256 internal constant Z15 = 0x1e63802bf470d89760cb1d7ed4e1e33dacd5c18bce21a25694c1eb34ba0960a1;
    uint256 internal constant Z16 = 0x0e44cadb0d26384c1464ffc989a1ac266552d121c6b99f8060db5086a758b30d;
    uint256 internal constant Z17 = 0x12c1f6877740d4a65ce63161e3b04aff6e6297a5e506aea5c482115eefbad37e;
    uint256 internal constant Z18 = 0x0fdad99e20e26efbc660470188aea0f870b66509469204e6d8f7e12c165fcb04;
    uint256 internal constant Z19 = 0x13efd091c87b2c70e592b2808e236dba7a243d07d710f22a38edf95e186f8e21;
    uint256 internal constant Z20 = 0x186219a926c0242d93da54e6746e12d18c71fe10950731e9f0d2175b6138c53c;
    uint256 internal constant Z21 = 0x0d1e6f3b7f27fc4fdc08da57b45d118b184c19f7d4530397b9c36ba0d69dcf32;
    uint256 internal constant Z22 = 0x201e10521f825645ed721b578a53952982d9bf338dd8cf714615b81ddece203a;
    uint256 internal constant Z23 = 0x1cc0eb300e140a36de6730b032f47c970cc44475120a861f25262fdf82de555e;
    uint256 internal constant Z24 = 0x24d074effc2b3ed91ef7de08d6ef63745af33f2ec5fc65e155bd4c1ccd20e739;

    /// @notice Z[level] for level in [0, 24]. Binary dispatch keeps the lookup at <= 5 comparisons.
    function zeros(uint256 level) internal pure returns (uint256) {
        if (level < 12) {
            if (level < 6) {
                if (level < 3) {
                    if (level == 0) return Z0;
                    if (level == 1) return Z1;
                    return Z2;
                }
                if (level == 3) return Z3;
                if (level == 4) return Z4;
                return Z5;
            }
            if (level < 9) {
                if (level == 6) return Z6;
                if (level == 7) return Z7;
                return Z8;
            }
            if (level == 9) return Z9;
            if (level == 10) return Z10;
            return Z11;
        }
        if (level < 18) {
            if (level < 15) {
                if (level == 12) return Z12;
                if (level == 13) return Z13;
                return Z14;
            }
            if (level == 15) return Z15;
            if (level == 16) return Z16;
            return Z17;
        }
        if (level < 21) {
            if (level == 18) return Z18;
            if (level == 19) return Z19;
            return Z20;
        }
        if (level == 21) return Z21;
        if (level == 22) return Z22;
        if (level == 23) return Z23;
        if (level == 24) return Z24;
        revert ZeroIndexOutOfRange(level);
    }
}
