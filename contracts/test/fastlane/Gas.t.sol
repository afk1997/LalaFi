// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FastlaneBase} from "./FastlaneBase.sol";
import {L2Deposit} from "../../src/libraries/Types.sol";

/// @notice Gas measurements (PRD 7.10). HubCore is a recording double, so the Merkle insertion
///         cost of the real HubCore (≈ 24 Poseidon hashes per leaf pair) is NOT included.
contract GasTest is FastlaneBase {
    function setUp() public override {
        super.setUp();
        _addValidators(7, 20_000e6, 10_000e6, 10_000e6);
        _advance();
    }

    function test_gas_submitAttestation_16x7() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 16, 100e6);
        (address[] memory s, bytes[] memory g) = _signAll(BASE, 1, ds, _allPks());
        vm.prank(submitter);
        uint256 g0 = gasleft();
        dm.submitAttestation(BASE, 1, ds, s, g);
        emit log_named_uint("submitAttestation(16 deposits, 7 signers)", g0 - gasleft());
    }

    function test_gas_processCheckpoint() public {
        // 16 fast items to confirm (one batch) + 16 slow items
        L2Deposit[] memory ds = _spokeDeposits(BASE, 16, 100e6);
        _attest(BASE, 1, ds, _allPks());
        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        uint256 g0 = gasleft();
        _process(BASE, seq, 0);
        emit log_named_uint("processCheckpoint: 16 fast confirms (total)", g0 - gasleft());
        emit log_named_uint("processCheckpoint: per fast confirm", (g0 - gasleft()) / 16);

        _spokeDeposits(BASE, 16, 100e6);
        (seq,) = _sendCheckpoint(BASE, 64);
        g0 = gasleft();
        _process(BASE, seq, 0);
        emit log_named_uint("processCheckpoint: 16 slow inserts (total)", g0 - gasleft());
        emit log_named_uint("processCheckpoint: per slow insert", (g0 - gasleft()) / 16);
    }

    function test_gas_proveAbsence() public {
        L2Deposit[] memory fut = _one(L2Deposit(50, 9, 1_000e6, 0, 0));
        _attest(BASE, 1, fut, _allPks());
        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        uint256 g0 = gasleft();
        dm.proveAbsence(BASE, seq, 1, fut, 0);
        emit log_named_uint("proveAbsence (1 item, 7 signers slashed)", g0 - gasleft());
    }

    function test_gas_proveEquivocation() public {
        L2Deposit[] memory a = _one(L2Deposit(3, 1, 5e6, 0, 1));
        L2Deposit[] memory b = _one(L2Deposit(3, 2, 5e6, 0, 1));
        bytes memory sa = _sig(pks[0], dm.batchDigest(BASE, 1, a));
        bytes memory sb = _sig(pks[0], dm.batchDigest(BASE, 1, b));
        uint256 g0 = gasleft();
        dm.proveEquivocation(BASE, vm.addr(pks[0]), 1, a, sa, 0, 1, b, sb, 0);
        emit log_named_uint("proveEquivocation", g0 - gasleft());
    }

    function test_gas_mismatchSlash() public {
        L2Deposit[] memory ds = _spokeDeposits(BASE, 1, 100e6);
        _attest(BASE, 1, _one(L2Deposit(ds[0].index, ds[0].ownerDigest, 900e6, ds[0].fee, ds[0].l2Block)), _allPks());
        (uint64 seq,) = _sendCheckpoint(BASE, 64);
        uint256 g0 = gasleft();
        _process(BASE, seq, 0);
        emit log_named_uint("processCheckpoint: 1 mismatch (7 slashes + true leaf)", g0 - gasleft());
    }

    function test_gas_deposit() public {
        address user = makeAddr("user");
        usdc.mint(user, 10e6);
        vm.startPrank(user);
        usdc.approve(address(dm), 10e6);
        uint256 g0 = gasleft();
        dm.deposit(10e6, 123, "");
        emit log_named_uint("deposit (L1)", g0 - gasleft());
        vm.stopPrank();
    }

    function test_gas_advanceEpoch_32() public {
        for (uint256 i; i < 25; ++i) {
            _addValidator(1_000e6, 500e6, 500e6);
        }
        vm.warp(block.timestamp + EPOCH);
        uint256 g0 = gasleft();
        sm.advanceEpoch();
        emit log_named_uint("advanceEpoch (32 active, 25 activations)", g0 - gasleft());
        vm.warp(block.timestamp + EPOCH);
        g0 = gasleft();
        sm.advanceEpoch();
        emit log_named_uint("advanceEpoch (32 active, steady)", g0 - gasleft());
    }
}
