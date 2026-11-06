// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LOCAL-ONLY mock bridge / CCTP surfaces.
/// @notice Implemented in contracts/src/mocks/** (contracts-bridges) and driven off-chain by
///         services/mock-bridge (services). Both sides MUST match these signatures exactly.
///         Each mock that "delivers" a message is restricted to a single `relayer` EOA set in the
///         constructor (the mock-bridge service key), standing in for the real bridge's proof system.

/// OP-style messenger, deployed on the L1 (31337) and on the OP-style L2 (31338).
interface IMockCrossDomainMessenger {
    /// Same shape as the real OP `SentMessage` event.
    event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit);
    event RelayedMessage(bytes32 indexed msgHash);
    event FailedRelayedMessage(bytes32 indexed msgHash);

    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external payable;
    function xDomainMessageSender() external view returns (address);

    /// @notice Only `relayer`. Sets xDomainMessageSender = sender for the duration of the call,
    ///         calls target with `gasLimit` gas. On failure records the hash (replayable) instead of reverting.
    ///         Replays of a successful message revert.
    function relayMessage(uint256 nonce, address sender, address target, bytes calldata message, uint256 gasLimit)
        external;
    function relayer() external view returns (address);
}

/// Arbitrum-style inbox on L1 (31337). Delivery to L2 is done by the service impersonating
/// AddressAliasHelper.applyL1ToL2Alias(from) on 31339 (anvil_impersonateAccount) and calling `to`.
interface IMockInbox {
    event RetryableCreated(
        uint256 indexed ticketId, address from, address to, uint256 l2CallValue, uint256 gasLimit, bytes data
    );

    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);

    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) external view returns (uint256);
}

/// Placed at address(100) on 31339 with anvil_setCode.
interface IMockArbSys {
    event L2ToL1Tx(address caller, address indexed destination, uint256 indexed position, bytes data);

    function arbBlockNumber() external view returns (uint256); // returns block.number
    function sendTxToL1(address destination, bytes calldata data) external payable returns (uint256 position);
}

/// Arbitrum-style bridge + outbox on L1 (31337).
interface IMockBridge {
    function activeOutbox() external view returns (address);
    /// @notice Only the active outbox. Calls `to` with msg.sender == bridge.
    function executeCall(address to, uint256 value, bytes calldata data)
        external
        returns (bool success, bytes memory returnData);
}

interface IMockOutbox {
    event OutBoxTransactionExecuted(address indexed to, address indexed l2Sender, uint256 indexed position);

    function l2ToL1Sender() external view returns (address);
    /// @notice Only `relayer`. Sets l2ToL1Sender = l2Sender, then bridge.executeCall(to, 0, data).
    ///         Each position executes once; reverts if the call fails (retryable by re-calling).
    function executeTransaction(uint256 position, address l2Sender, address to, bytes calldata data) external;
    function relayer() external view returns (address);
}

/// CCTP V2 stand-ins, one pair per chain. Message format (mock only):
///   abi.encode(uint64 nonce, uint32 srcDomain, uint32 dstDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee)
/// Minted amount = amount - maxFee (mock charges the full maxFee).
/// Attestation = 65-byte ECDSA signature by `attester` over keccak256(message) (EIP-191 not applied).
interface IMockTokenMessengerV2 {
    event DepositForBurn(
        uint64 indexed nonce,
        address burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        uint256 maxFee,
        uint32 minFinalityThreshold
    );
    event MessageSent(bytes message);

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
    function localDomain() external view returns (uint32);
}

interface IMockMessageTransmitterV2 {
    event MintAndWithdraw(address indexed mintRecipient, uint256 amount, uint64 indexed nonce, uint32 srcDomain);

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
    function attester() external view returns (address);
    function localDomain() external view returns (uint32);
    function usedNonce(uint32 srcDomain, uint64 nonce) external view returns (bool);
}
