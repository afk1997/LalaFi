// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IMockMessageTransmitterV2} from "../interfaces/IMocks.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice LOCAL ONLY. CCTP V2 MessageTransmitter stand-in. Verifies a 65-byte ECDSA signature of
///         `attester` over keccak256(message) (no EIP-191 prefix), checks the destination domain, burns
///         the (srcDomain, nonce) pair and mints amount - maxFee to mintRecipient.
contract MockMessageTransmitterV2 is IMockMessageTransmitterV2 {
    error WrongDomain(uint32 dstDomain);
    error BadAttestation();
    error NonceUsed(uint32 srcDomain, uint64 nonce);

    address public immutable usdc;
    uint32 public immutable override localDomain;
    address public immutable override attester;
    mapping(uint32 => mapping(uint64 => bool)) public override usedNonce;

    constructor(address usdc_, uint32 localDomain_, address attester_) {
        usdc = usdc_;
        localDomain = localDomain_;
        attester = attester_;
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external override returns (bool) {
        (uint64 nonce, uint32 srcDomain, uint32 dstDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee) =
            abi.decode(message, (uint64, uint32, uint32, bytes32, uint256, uint256));
        if (dstDomain != localDomain) revert WrongDomain(dstDomain);
        if (attestation.length != 65) revert BadAttestation();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(keccak256(message), attestation);
        if (err != ECDSA.RecoverError.NoError || signer != attester) revert BadAttestation();
        if (usedNonce[srcDomain][nonce]) revert NonceUsed(srcDomain, nonce);
        usedNonce[srcDomain][nonce] = true;

        address recipient = address(uint160(uint256(mintRecipient)));
        uint256 minted = amount - maxFee;
        MockUSDC(usdc).mint(recipient, minted);
        emit MintAndWithdraw(recipient, minted, nonce, srcDomain);
        return true;
    }
}
