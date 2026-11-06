// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeParams} from "../libraries/Types.sol";

/// @title LiquidityManager (PRD 7.7, 11) — L1 vault, ledger L[c], LP shares, insurance, fees, CCTP.
/// @notice Holds every USDC unit on Ethereum except validator stake (StakeManager).
///         LP shares are an ERC-20 ("xpool LP", decimals 6) using ERC-4626 math with a
///         virtual-share offset (_decimalsOffset = 6) against the inflation attack.
///
/// Ledger semantics (PRD 11.1 / 11.2):
///   - reserve(c, a)      : L[c] -= a (reverts InsufficientLiquidity(c) if L[c] < a). HubCore.
///   - payOnL1(to, a)     : pure USDC transfer of an amount ALREADY reserved on ETH. HubCore.
///   - payRelayer(r, a)   : if L[ETH] >= a then L[ETH] -= a and pay, else claimable[r] += a. HubCore.
///   - accrueProtocolFee  : splits alphaV (reward pot) / alphaLP (lpAssets) / alphaIns (insurance). HubCore.
///   - credit(c, a)       : L[c] += a. DepositManager.
///   - creditBounty(to,a) : claimable[to] += a (settlement-fee bounties). DepositManager.
///   - receiveSlashed(a)  : StakeManager has transferred `a` USDC in; insurance += a; L[ETH] += a.
///   - takeRewardPot()    : moves the accrued validator pot to StakeManager. StakeManager.
interface ILiquidityManager {
    // ------------------------------------------------------------------ errors
    error InsufficientLiquidity(uint64 chainId);
    error Unauthorized();
    error UnsupportedChain(uint64 chainId);
    error InflowsPaused();
    error SafetyValve();
    error ZeroAmount();
    error RebalancePolicy();
    error OnlyGuardian();
    error OutOfBounds();

    // ------------------------------------------------------------------ events
    event Reserved(uint64 indexed chainId, uint256 amount);
    event Credited(uint64 indexed chainId, uint256 amount);
    event PaidOnL1(address indexed to, uint256 amount);
    event RelayerPaid(address indexed relayer, uint256 amount, bool claimable);
    event ProtocolFeeAccrued(uint256 amount, uint256 toValidators, uint256 toLps, uint256 toInsurance);
    event BountyCredited(address indexed to, uint256 amount);
    event Claimed(address indexed to, uint256 amount);
    event SlashedReceived(uint256 amount);
    event RewardPotTaken(uint256 amount);
    event LiquidityAdded(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
    event LiquidityRemoved(address indexed owner, address indexed receiver, uint256 assets, uint256 shares);
    event Rebalanced(uint64 indexed srcChainId, uint64 indexed dstChainId, uint256 amount, uint256 maxFee, uint64 nonce);
    event TargetsUpdated(uint256 ethBps, uint256 baseBps, uint256 arbBps);

    // ------------------------------------------------------------------ ledger (restricted)
    function reserve(uint64 chainId, uint256 amount) external;
    function credit(uint64 chainId, uint256 amount) external;
    function payOnL1(address to, uint256 amount) external;
    function payRelayer(address relayer, uint256 amount) external;
    function accrueProtocolFee(uint256 amount) external;
    function creditBounty(address to, uint256 amount) external;
    function receiveSlashed(uint256 amount) external;
    function takeRewardPot() external returns (uint256 amount);

    // ------------------------------------------------------------------ balances
    function claim() external; // relayers, bounty earners

    // ------------------------------------------------------------------ LPs [P0]
    function addLiquidity(uint256 assets, address receiver) external returns (uint256 shares);
    function removeLiquidity(uint256 shares, address receiver) external returns (uint256 assets);
    function previewAdd(uint256 assets) external view returns (uint256 shares);
    function previewRemove(uint256 shares) external view returns (uint256 assets);

    // ------------------------------------------------------------------ rebalancing [P0] (PRD 11.3)
    /// @notice Permissionless within policy. msg.value funds the Arbitrum retryable when src = ARB.
    function rebalance(uint64 srcChainId, uint64 dstChainId, uint256 amount, BridgeParams calldata bp)
        external
        payable;

    // ------------------------------------------------------------------ guardian (bounded)
    function setTargets(uint256 ethBps, uint256 baseBps, uint256 arbBps) external;

    // ------------------------------------------------------------------ views
    function available(uint64 chainId) external view returns (uint256); // L[c]
    function lpAssets() external view returns (uint256);
    function insurance() external view returns (uint256);
    function rewardPot() external view returns (uint256);
    function claimable(address account) external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function target(uint64 chainId) external view returns (uint256);
    function targetBps(uint64 chainId) external view returns (uint256);
    function rebalanceNonce() external view returns (uint64);
}
