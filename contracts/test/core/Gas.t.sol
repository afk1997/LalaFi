// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {CoreBase} from "./utils/CoreBase.sol";
import {ExtData, PublicInputs, BridgeParams} from "../../src/libraries/Types.sol";

contract NoopAdapter {
    function sendToSpoke(bytes calldata, BridgeParams calldata) external payable {}
}

/// @notice Steady-state gas of the hot paths (warm tree, not the first insertion; excludes the
///         21k intrinsic and calldata cost). Run with -vv to print. Uses MockVerifier, so add the
///         real Groth16 verification cost (~200-250k) for production numbers, and the real adapter's
///         canonical send (OP ~80k, Arbitrum ~100k) for L2 destinations.
contract CoreGasTest is CoreBase {
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < 4; ++i) {
            _depositEth(10_000e6);
            _depositL2(BASE, 10_000e6);
            _depositL2(ARB, 10_000e6);
        }
        // Hub-side cost only: replace the recording mock adapters with no-ops.
        NoopAdapter noop = new NoopAdapter();
        vm.etch(address(baseAdapter), address(noop).code);
        vm.etch(address(arbAdapter), address(noop).code);
        _transact(_ext(BASE, bob, 1e6, BUCKET)); // warm release slots
    }

    function _measureTransact(ExtData memory e) internal returns (uint256) {
        PublicInputs memory pi = _pi(e);
        hub.transact(_proof(), pi, e, _bp());
        Vm.Gas memory g = vm.lastCallGas();
        return g.gasTotalUsed;
    }

    function test_gas_transact() public {
        emit log_named_uint("transact -> Ethereum", _measureTransact(_ext(ETH, bob, 100e6, 25 * BUCKET)));
        emit log_named_uint("transact -> Base    ", _measureTransact(_ext(BASE, bob, 100e6, 25 * BUCKET)));
        emit log_named_uint("transact -> Arbitrum", _measureTransact(_ext(ARB, bob, 100e6, 25 * BUCKET)));
        emit log_named_uint("transact transfer   ", _measureTransact(_ext(0, address(0), 0, 25 * BUCKET)));
    }

    function test_gas_insertDepositLeaves() public {
        uint256[] memory one = new uint256[](1);
        one[0] = _freshCommitment();
        dm.insert(one, 1e6);
        emit log_named_uint("insertDepositLeaves(1) via DM", vm.lastCallGas().gasTotalUsed);
        uint256[] memory two = new uint256[](2);
        two[0] = _freshCommitment();
        two[1] = _freshCommitment();
        dm.insert(two, 2e6);
        emit log_named_uint("insertDepositLeaves(2) via DM", vm.lastCallGas().gasTotalUsed);
        uint256[] memory sixteen = new uint256[](16);
        for (uint256 i; i < 16; ++i) {
            sixteen[i] = _freshCommitment();
        }
        dm.insert(sixteen, 16e6);
        emit log_named_uint("insertDepositLeaves(16) via DM", vm.lastCallGas().gasTotalUsed);
    }
}
