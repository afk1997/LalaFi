// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CREATE3} from "solady/utils/CREATE3.sol";

/// @title Create3Factory (docs/IMPLEMENTATION.md decision 1)
/// @notice address = f(factory, deployer, salt), independent of init code, so every protocol address is
///         known before any constructor runs and all cross-references can be immutables.
///         The factory itself is deployed with CREATE2 through 0x4e59b44847b379578588920cA78FbF26c0B4956C
///         (same address on every chain). Salts are namespaced by msg.sender: only the same deployer
///         can occupy (or front-run) its addresses, so the same EOA must deploy on all chains.
///         No owner, no state.
contract Create3Factory {
    event Deployed(address indexed deployer, bytes32 indexed salt, address deployed);

    function deploy(bytes32 salt, bytes calldata initCode) external payable returns (address deployed) {
        deployed = CREATE3.deployDeterministic(msg.value, initCode, _namespaced(msg.sender, salt));
        emit Deployed(msg.sender, salt, deployed);
    }

    function predict(address deployer, bytes32 salt) external view returns (address) {
        return CREATE3.predictDeterministicAddress(_namespaced(deployer, salt), address(this));
    }

    function _namespaced(address deployer, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(deployer, salt));
    }
}
