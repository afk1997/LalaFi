// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {XpoolBase} from "./base/XpoolBase.s.sol";

/// @notice PRD 14.5 step 1. Prints every CREATE3 address for XPOOL_CONFIG (default XPOOL_ENV) and writes
///         deployments/<XPOOL_CONFIG>.predicted.json. No RPC and no broadcast needed.
///
///   XPOOL_ENV=testnet DEPLOYER=0xYourDeployerEOA forge script script/PredictAddresses.s.sol
///   (DEPLOYER defaults to the address of DEPLOYER_PRIVATE_KEY; locally to Anvil account 0)
contract PredictAddresses is XpoolBase {
    function run() external {
        _load();
        address deployer = vm.envOr("DEPLOYER", address(0));
        if (deployer == address(0)) deployer = vm.addr(_deployerKey());
        Addrs memory a = _predictAll(deployer);
        console.log("env      ", env);
        console.log("config   ", configName);
        console.log("salt     ", salt);
        console.log("deployer ", deployer);
        _logAddrs(a);

        string memory o = "predicted";
        vm.serializeString(o, "environment", env);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "create3Factory", a.factory);
        vm.serializeAddress(o, N_POSEIDON_T3, a.poseidonT3);
        vm.serializeAddress(o, N_POSEIDON_T4, a.poseidonT4);
        vm.serializeAddress(o, N_VERIFIER, a.verifier);
        vm.serializeAddress(o, N_STAKE, a.stakeManager);
        vm.serializeAddress(o, N_LIQUIDITY, a.liquidityManager);
        vm.serializeAddress(o, N_DEPOSIT, a.depositManager);
        vm.serializeAddress(o, N_HUB, a.hubCore);
        vm.serializeAddress(o, N_OP_ADAPTER, a.opAdapter);
        string memory out = vm.serializeAddress(o, N_BASE_SPOKE, a.baseSpoke);
        if (hasArb) {
            vm.serializeAddress(o, N_ARB_ADAPTER, a.arbAdapter);
            out = vm.serializeAddress(o, N_ARB_SPOKE, a.arbSpoke);
        }
        vm.writeJson(out, string.concat(vm.projectRoot(), "/../deployments/", configName, ".predicted.json"));
    }
}
