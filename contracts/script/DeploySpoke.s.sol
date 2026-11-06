// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {XpoolBase} from "./base/XpoolBase.s.sol";

/// @notice PRD 14.5 step 3, on Base (OpStackSpoke) or Arbitrum (ArbitrumSpoke). The stack is chosen by
///         block.chainid. Uses the SAME deployer key as DeployHub, so the hub adapters' immutable `spoke`
///         equals the address deployed here. Updates deployments/<env>.json -> spokes.<chainId>.
///
///   XPOOL_ENV=testnet DEPLOYER_PRIVATE_KEY=0x... forge script script/DeploySpoke.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast
///   XPOOL_ENV=testnet DEPLOYER_PRIVATE_KEY=0x... forge script script/DeploySpoke.s.sol --rpc-url $ARB_SEPOLIA_RPC --broadcast
contract DeploySpoke is XpoolBase {
    function run() external {
        _load();
        require(!_isLocal(), "local: use script/deploy-local.sh (DeployLocal.s.sol)");
        bool isBase = block.chainid == baseChainId;
        require(isBase || block.chainid == arbChainId, "not a configured spoke chain");
        uint256 pk = _deployerKey();
        address deployer = vm.addr(pk);
        Addrs memory a = _predictAll(deployer);
        External memory x = _externalFromConfig();

        uint256 deployBlock = _l2Block(isBase);
        vm.startBroadcast(pk);
        address s = _deploySpokeContract(deployer, isBase, a, x);
        vm.stopBroadcast();

        _ensureSkeleton(deployer, a, x);
        _writeSpokeSection(isBase, isBase ? x.baseUsdc : x.arbUsdc, s, deployBlock);
        console.log("wrote", _deploymentsPath());
    }

    /// @dev Same clock as Spoke.l2BlockNumber() (ArbSys on Arbitrum).
    function _l2Block(bool isBase) internal view returns (uint256) {
        if (isBase) return block.number;
        (bool ok, bytes memory ret) = address(100).staticcall(abi.encodeWithSignature("arbBlockNumber()"));
        return ok && ret.length == 32 ? abi.decode(ret, (uint256)) : block.number;
    }
}
