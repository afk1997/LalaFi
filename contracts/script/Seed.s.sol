// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XpoolBase} from "./base/XpoolBase.s.sol";
import {IStakeManager} from "../src/interfaces/IStakeManager.sol";
import {ILiquidityManager} from "../src/interfaces/ILiquidityManager.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice PRD 14.5 step 5, on the hub chain: validators register / bond / allocate, an LP adds
///         liquidity; `advance()` then calls advanceEpoch (once epochSeconds have elapsed).
///         Reads addresses from deployments/<env>.json.
///
///   local:   keys from the Anvil mnemonic (operators 5-8, signers 9-12, LP 13); MockUSDC is minted.
///   testnet: SEED_OPERATOR_KEYS=0xk1,0xk2,..  SEED_SIGNERS=0xa1,0xa2,..  SEED_LP_KEY=0x..
///            (accounts must already hold Sepolia USDC and ETH)
///   optional: SEED_BOND (per validator, default 10 * sMin), SEED_LP_AMOUNT (default 100k USDC local,
///             100 USDC otherwise)
///
///   XPOOL_ENV=testnet forge script script/Seed.s.sol --rpc-url $SEPOLIA_RPC --broadcast
///   XPOOL_ENV=testnet DEPLOYER_PRIVATE_KEY=0x.. forge script script/Seed.s.sol --sig "advance()" --rpc-url $SEPOLIA_RPC --broadcast
contract Seed is XpoolBase {
    IStakeManager internal sm;
    ILiquidityManager internal lm;
    IERC20 internal usdc;

    function _init() internal {
        _load();
        string memory d = vm.readFile(_deploymentsPath());
        sm = IStakeManager(vm.parseJsonAddress(d, ".hub.contracts.StakeManager"));
        lm = ILiquidityManager(vm.parseJsonAddress(d, ".hub.contracts.LiquidityManager"));
        usdc = IERC20(vm.parseJsonAddress(d, ".hub.usdc"));
        require(block.chainid == hubChainId, "Seed runs on the hub chain");
    }

    function run() external {
        _init();
        uint256[] memory opKeys;
        address[] memory signers;
        uint256 lpKey;
        if (_isLocal()) {
            opKeys = new uint256[](4);
            signers = new address[](4);
            for (uint32 i; i < 4; ++i) {
                opKeys[i] = _anvilKey(5 + i);
                signers[i] = vm.addr(_anvilKey(9 + i));
            }
            lpKey = _anvilKey(13);
        } else {
            opKeys = vm.envUint("SEED_OPERATOR_KEYS", ",");
            signers = vm.envAddress("SEED_SIGNERS", ",");
            lpKey = vm.envUint("SEED_LP_KEY");
        }
        require(opKeys.length == signers.length, "operator / signer count mismatch");

        uint256 bond = vm.envOr("SEED_BOND", 10 * sm.sMin());
        uint64[] memory chains = new uint64[](2);
        chains[0] = baseChainId;
        chains[1] = arbChainId;
        uint256[] memory alloc = new uint256[](2);
        alloc[0] = bond / 2;
        alloc[1] = bond / 2;

        for (uint256 i; i < opKeys.length; ++i) {
            address op = vm.addr(opKeys[i]);
            bool registered = _isRegistered(signers[i]);
            vm.startBroadcast(opKeys[i]);
            if (_isLocal()) MockUSDC(address(usdc)).mint(op, bond);
            usdc.approve(address(sm), bond);
            if (!registered) sm.register(signers[i]);
            sm.bond(bond);
            sm.setAllocations(chains, alloc);
            vm.stopBroadcast();
            console.log("validator operator", op, "signer", signers[i]);
        }

        uint256 lpAmount = vm.envOr("SEED_LP_AMOUNT", _isLocal() ? uint256(100_000e6) : uint256(100e6));
        address lp = vm.addr(lpKey);
        vm.startBroadcast(lpKey);
        if (_isLocal()) MockUSDC(address(usdc)).mint(lp, lpAmount);
        usdc.approve(address(lm), lpAmount);
        lm.addLiquidity(lpAmount, lp);
        vm.stopBroadcast();
        console.log("LP", lp, "added", lpAmount);
        console.log("next: wait epochSeconds, then run with --sig 'advance()'");
    }

    /// @notice Permissionless advanceEpoch, sent by the deployer key.
    function advance() external {
        _init();
        vm.startBroadcast(_deployerKey());
        sm.advanceEpoch();
        vm.stopBroadcast();
        console.log("epoch", sm.currentEpoch());
    }

    function _isRegistered(address signer) internal view returns (bool) {
        try sm.validatorBySigner(signer) returns (uint32 id, bool, bool) {
            try sm.signerOf(id) returns (address s) {
                return s == signer;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }
}
