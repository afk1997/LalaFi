// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL/TEST ONLY. 6-decimal USDC stand-in with a Circle-style blacklist and a
///         minter role (MockCCTP mints through it). Never deployed on testnet/mainnet.
contract MockUSDC is ERC20 {
    error Blacklisted(address account);
    error NotAdmin();

    address public immutable admin;
    mapping(address => bool) public isBlacklisted;
    mapping(address => bool) public isMinter;

    constructor() ERC20("USD Coin (mock)", "USDC") {
        admin = msg.sender;
        isMinter[msg.sender] = true;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Faucet: open mint for local testing.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotAdmin();
        _burn(from, amount);
    }

    function setMinter(address minter, bool allowed) external {
        if (msg.sender != admin) revert NotAdmin();
        isMinter[minter] = allowed;
    }

    function setBlacklisted(address account, bool blocked) external {
        if (msg.sender != admin) revert NotAdmin();
        isBlacklisted[account] = blocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (isBlacklisted[from]) revert Blacklisted(from);
        if (isBlacklisted[to]) revert Blacklisted(to);
        super._update(from, to, value);
    }
}
