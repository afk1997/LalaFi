// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title TESTNET ONLY: a CCTP-V2-shaped mover for tokens Circle doesn't support (e.g. test DAI).
/// @notice One contract per chain acts as both TokenMessengerV2 and MessageTransmitterV2, so the pool's
///         rebalancing (LiquidityManager / Spoke -> depositForBurn, keeper -> receiveMessage) works
///         unchanged. "Burn" = lock the tokens here; "mint" = release from this contract's stock on the
///         destination chain, authorised by `attester`'s ECDSA signature over keccak256(message).
///         Trust model: whoever holds the attester key can release this contract's stock. That is an
///         accepted testnet shortcut; mainnet pools must use real CCTP (or another canonical bridge).
///         Message format = the local mocks': abi.encode(nonce, srcDomain, dstDomain, mintRecipient, amount, maxFee).
contract LockReleaseMessenger is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error WrongToken(address token);
    error WrongDomain(uint32 dstDomain);
    error BadAttestation();
    error NonceUsed(uint32 srcDomain, uint64 nonce);
    error ZeroAmount();
    error InsufficientStock(uint256 have, uint256 need);

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
    event MintAndWithdraw(address indexed mintRecipient, uint256 amount, uint64 indexed nonce, uint32 srcDomain);

    address public immutable token;
    uint32 public immutable localDomain;
    address public immutable attester;
    uint64 public nextNonce;
    mapping(uint32 => mapping(uint64 => bool)) public usedNonce;

    constructor(address token_, uint32 localDomain_, address attester_) {
        token = token_;
        localDomain = localDomain_;
        attester = attester_;
    }

    /// @notice CCTP V2 TokenMessenger.depositForBurn shape. Locks `amount` of `burnToken` from the caller.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32, /* destinationCaller */
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external nonReentrant {
        if (burnToken != token) revert WrongToken(burnToken);
        if (amount == 0 || maxFee > amount) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint64 nonce = nextNonce++;
        bytes memory message = abi.encode(nonce, localDomain, destinationDomain, mintRecipient, amount, maxFee);
        emit DepositForBurn(nonce, burnToken, amount, msg.sender, mintRecipient, destinationDomain, maxFee, minFinalityThreshold);
        emit MessageSent(message);
    }

    /// @notice CCTP V2 MessageTransmitter.receiveMessage shape. Releases amount - maxFee from stock.
    function receiveMessage(bytes calldata message, bytes calldata attestation) external nonReentrant returns (bool) {
        (uint64 nonce, uint32 srcDomain, uint32 dstDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee) =
            abi.decode(message, (uint64, uint32, uint32, bytes32, uint256, uint256));
        if (dstDomain != localDomain) revert WrongDomain(dstDomain);
        if (attestation.length != 65) revert BadAttestation();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(keccak256(message), attestation);
        if (err != ECDSA.RecoverError.NoError || signer != attester) revert BadAttestation();
        if (usedNonce[srcDomain][nonce]) revert NonceUsed(srcDomain, nonce);
        usedNonce[srcDomain][nonce] = true;
        uint256 out = amount - maxFee;
        uint256 have = IERC20(token).balanceOf(address(this));
        if (have < out) revert InsufficientStock(have, out);
        address recipient = address(uint160(uint256(mintRecipient)));
        IERC20(token).safeTransfer(recipient, out);
        emit MintAndWithdraw(recipient, out, nonce, srcDomain);
        return true;
    }
}
