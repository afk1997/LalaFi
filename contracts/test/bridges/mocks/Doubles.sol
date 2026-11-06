// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHubAdapter} from "../../../src/interfaces/IHubAdapter.sol";
import {BridgeParams, Checkpoint} from "../../../src/libraries/Types.sol";

/// @notice Stand-in for HubCore / LiquidityManager: the only callers the adapters accept.
contract HubCallerDouble {
    function send(address adapter, bytes calldata message, BridgeParams calldata bp) external payable {
        IHubAdapter(adapter).sendToSpoke{value: msg.value}(message, bp);
    }
}

/// @notice Stand-in for DepositManager.receiveCheckpoint: only the registered adapter per chain.
contract DepositManagerDouble {
    error OnlyAdapter();
    error BadCheckpoint();

    mapping(uint64 => address) public adapterOf;
    mapping(uint64 => uint256) public received;
    mapping(uint64 => mapping(uint64 => bytes32)) public payloadHash;
    /// @dev The real DepositManager only stores a hash (fits minGasL1); so does this double.
    event CheckpointPayload(uint64 indexed srcChainId, bytes payload);

    function setAdapter(uint64 chainId, address adapter) external {
        adapterOf[chainId] = adapter;
    }

    function receiveCheckpoint(uint64 srcChainId, bytes calldata payload) external {
        if (msg.sender != adapterOf[srcChainId]) revert OnlyAdapter();
        Checkpoint memory cp = abi.decode(payload, (Checkpoint));
        if (cp.to - cp.from != cp.deposits.length) revert BadCheckpoint();
        for (uint256 k; k < cp.deposits.length; ++k) {
            if (cp.deposits[k].index != cp.from + k) revert BadCheckpoint();
        }
        payloadHash[srcChainId][cp.seq] = keccak256(payload);
        received[srcChainId]++;
        emit CheckpointPayload(srcChainId, payload);
    }
}

/// @notice A token-messenger that always reverts (CCTP paused).
contract RevertingTokenMessenger {
    error Paused();

    function depositForBurn(uint256, uint32, bytes32, address, bytes32, uint256, uint32) external pure {
        revert Paused();
    }
}
