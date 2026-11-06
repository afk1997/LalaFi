// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {XpoolBase} from "./base/XpoolBase.s.sol";

/// @notice PRD 14.5 step 2, on the hub chain (Sepolia for testnet). Deploys Create3Factory (if absent),
///         PoseidonT3/T4, Groth16Verifier, StakeManager, LiquidityManager, DepositManager, HubCore and both
///         hub adapters at their predicted addresses, then writes deployments/<env>.json.
///         Idempotent: contracts already at their predicted address are skipped.
///
///   XPOOL_ENV=testnet DEPLOYER_PRIVATE_KEY=0x... GUARDIAN=0xSafe \
///     forge script script/DeployHub.s.sol --rpc-url $SEPOLIA_RPC --broadcast --slow
contract DeployHub is XpoolBase {
    function run() external {
        _load();
        require(!_isLocal(), "local: use script/deploy-local.sh (DeployLocal.s.sol)");
        uint256 pk = _deployerKey();
        address deployer = vm.addr(pk);
        Addrs memory a = _predictAll(deployer);
        External memory x = _externalFromConfig();
        console.log("deployer", deployer);
        _logAddrs(a);

        uint256 deployBlock = block.number;
        vm.startBroadcast(pk);
        _deployHubContracts(deployer, a, x);
        vm.stopBroadcast();

        _ensureSkeleton(deployer, a, x);
        _writeHubSection(a, deployBlock, x.hubUsdc);
        console.log("wrote", _deploymentsPath());
    }
}
