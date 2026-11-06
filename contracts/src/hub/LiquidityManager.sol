// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILiquidityManager} from "../interfaces/ILiquidityManager.sol";
import {IHubCore} from "../interfaces/IHubCore.sol";
import {IHubAdapter} from "../interfaces/IHubAdapter.sol";
import {IDepositManager} from "../interfaces/IDepositManager.sol";
import {ITokenMessengerV2, CCTP_FINALITY_STANDARD} from "../interfaces/external/ICCTP.sol";
import {MSG_REBALANCE, BridgeParams, RebalanceOrder} from "../libraries/Types.sol";
import {LiquidityManagerConfig} from "../libraries/DeployConfig.sol";

/// @title LiquidityManager (PRD 7.7, 11): L1 vault, ledger L[c], LP shares, insurance, fees, CCTP.
/// @notice Ledger semantics are documented at the top of ILiquidityManager. Nobody (guardian
///         included) can move funds except through the rules below. No upgradeability.
///
///         Accounting identity (no fast-lane fraud, maxFee = 0; checked by the core invariant tests):
///           Σ_c L[c] == shieldedSupply(confirmed part) + lpAssets + insurance + rewardPot + totalClaimable
///         L[c] counts the USDC backing *all* of these; claimables, the reward pot and insurance are
///         liabilities inside it that are paid from L[ETH] when they leave.
///
///         LP shares: ERC-20 "xpool LP" / "xLP", 6 decimals, ERC-4626 conversion math with a
///         virtual offset of 10^6 shares and 1 asset. `lpAssets` is internal accounting (never
///         balanceOf), so direct USDC donations cannot move the share price at all.
contract LiquidityManager is ILiquidityManager, ERC20, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error BadConfig();
    error UnexpectedValue();
    error ZeroAddress();

    uint256 private constant _BPS = 10_000;
    uint256 private constant _VIRTUAL_SHARES = 1e6; // 10 ** _decimalsOffset, _decimalsOffset = 6
    uint256 private constant _VIRTUAL_ASSETS = 1;
    /// @dev v1 always burns with maxFee = 0 and Standard finality (PRD 11.3).
    uint256 public constant REBALANCE_MAX_FEE = 0;
    uint32 public constant REBALANCE_MIN_FINALITY = CCTP_FINALITY_STANDARD;
    /// @dev cast sig "beta()"; DepositManager exposes beta() returns (uint256 num, uint256 den).
    bytes4 private constant _BETA_SELECTOR = bytes4(keccak256("beta()"));

    // ------------------------------------------------------------------ immutables
    IERC20 public immutable usdc;
    IHubCore public immutable hub;
    address public immutable depositManager;
    address public immutable stakeManager;
    ITokenMessengerV2 public immutable tokenMessenger;
    uint32 public immutable ethDomain;
    uint64 public immutable baseChainId;
    address public immutable baseAdapter;
    address public immutable baseSpoke;
    uint32 public immutable baseDomain;
    uint64 public immutable arbChainId;
    address public immutable arbAdapter;
    address public immutable arbSpoke;
    uint32 public immutable arbDomain;
    uint256 public immutable alphaVBps;
    uint256 public immutable alphaLPBps;
    uint256 public immutable alphaInsBps;
    uint256 public immutable targetBpsMin;
    uint256 public immutable targetBpsMax;
    uint256 public immutable minRebalance;

    // ------------------------------------------------------------------ state
    mapping(uint64 chainId => uint256) internal _liquidity; // L[c]
    mapping(uint64 chainId => uint256) internal _targetBps;
    mapping(address account => uint256) public claimable;
    uint256 public lpAssets;
    uint256 public insurance;
    uint256 public rewardPot;
    uint256 public totalClaimable;
    uint64 public rebalanceNonce; // number of rebalances so far; order nonces start at 1

    modifier only(address who) {
        if (msg.sender != who) revert Unauthorized();
        _;
    }

    constructor(LiquidityManagerConfig memory c) ERC20("xpool LP", "xLP") {
        if (
            c.usdc == address(0) || c.hub == address(0) || c.depositManager == address(0)
                || c.stakeManager == address(0) || c.tokenMessengerV2 == address(0) || c.baseAdapter == address(0)
                || c.baseSpoke == address(0) || c.arbAdapter == address(0) || c.arbSpoke == address(0)
        ) revert BadConfig();
        if (
            c.baseChainId == 0 || c.arbChainId == 0 || c.baseChainId == c.arbChainId || c.baseChainId == block.chainid
                || c.arbChainId == block.chainid
        ) revert BadConfig();
        if (c.ethDomain == c.baseDomain || c.ethDomain == c.arbDomain || c.baseDomain == c.arbDomain) {
            revert BadConfig();
        }
        if (c.alphaVBps + c.alphaLPBps + c.alphaInsBps != _BPS) revert BadConfig();
        if (c.targetBpsMin > c.targetBpsMax || c.targetBpsMax > _BPS) revert BadConfig();
        _checkTargets(c.targetBpsMin, c.targetBpsMax, c.targetEthBps, c.targetBaseBps, c.targetArbBps);
        if (c.minRebalance == 0) revert BadConfig();

        usdc = IERC20(c.usdc);
        hub = IHubCore(c.hub);
        depositManager = c.depositManager;
        stakeManager = c.stakeManager;
        tokenMessenger = ITokenMessengerV2(c.tokenMessengerV2);
        ethDomain = c.ethDomain;
        baseChainId = c.baseChainId;
        baseAdapter = c.baseAdapter;
        baseSpoke = c.baseSpoke;
        baseDomain = c.baseDomain;
        arbChainId = c.arbChainId;
        arbAdapter = c.arbAdapter;
        arbSpoke = c.arbSpoke;
        arbDomain = c.arbDomain;
        alphaVBps = c.alphaVBps;
        alphaLPBps = c.alphaLPBps;
        alphaInsBps = c.alphaInsBps;
        targetBpsMin = c.targetBpsMin;
        targetBpsMax = c.targetBpsMax;
        minRebalance = c.minRebalance;

        _targetBps[uint64(block.chainid)] = c.targetEthBps;
        _targetBps[c.baseChainId] = c.targetBaseBps;
        _targetBps[c.arbChainId] = c.targetArbBps;
        emit TargetsUpdated(c.targetEthBps, c.targetBaseBps, c.targetArbBps);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ================================================================== ledger (restricted)

    /// @inheritdoc ILiquidityManager
    function reserve(uint64 chainId, uint256 amount) external nonReentrant only(address(hub)) {
        _requireSupported(chainId);
        uint256 l = _liquidity[chainId];
        if (l < amount) revert InsufficientLiquidity(chainId);
        _liquidity[chainId] = l - amount;
        emit Reserved(chainId, amount);
    }

    /// @inheritdoc ILiquidityManager
    function credit(uint64 chainId, uint256 amount) external nonReentrant only(depositManager) {
        _requireSupported(chainId);
        _liquidity[chainId] += amount;
        emit Credited(chainId, amount);
    }

    /// @inheritdoc ILiquidityManager
    function payOnL1(address to, uint256 amount) external nonReentrant only(address(hub)) {
        if (to == address(0)) revert ZeroAddress();
        emit PaidOnL1(to, amount);
        if (amount > 0) usdc.safeTransfer(to, amount);
    }

    /// @inheritdoc ILiquidityManager
    /// @dev Falls back to a claimable balance if L[ETH] is short or the transfer itself fails
    ///      (e.g. a blacklisted relayer), so a relayer can never make a spend revert.
    function payRelayer(address relayer, uint256 amount) external nonReentrant only(address(hub)) {
        if (relayer == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        uint64 eth = uint64(block.chainid);
        uint256 l = _liquidity[eth];
        bool paid;
        if (l >= amount) {
            _liquidity[eth] = l - amount;
            paid = _tryTransfer(relayer, amount);
            if (!paid) _liquidity[eth] = l;
        }
        if (!paid) {
            claimable[relayer] += amount;
            totalClaimable += amount;
        }
        emit RelayerPaid(relayer, amount, !paid);
    }

    /// @inheritdoc ILiquidityManager
    /// @dev Validator and insurance shares round down; the dust goes to LPs.
    function accrueProtocolFee(uint256 amount) external nonReentrant only(address(hub)) {
        if (amount == 0) return;
        uint256 toV = Math.mulDiv(amount, alphaVBps, _BPS);
        uint256 toIns = Math.mulDiv(amount, alphaInsBps, _BPS);
        uint256 toLp = amount - toV - toIns;
        rewardPot += toV;
        insurance += toIns;
        lpAssets += toLp;
        emit ProtocolFeeAccrued(amount, toV, toLp, toIns);
    }

    /// @inheritdoc ILiquidityManager
    function creditBounty(address to, uint256 amount) external nonReentrant only(depositManager) {
        if (to == address(0)) revert ZeroAddress();
        claimable[to] += amount;
        totalClaimable += amount;
        emit BountyCredited(to, amount);
    }

    /// @inheritdoc ILiquidityManager
    function receiveSlashed(uint256 amount) external nonReentrant only(stakeManager) {
        insurance += amount;
        _liquidity[uint64(block.chainid)] += amount;
        emit SlashedReceived(amount);
    }

    /// @inheritdoc ILiquidityManager
    function takeRewardPot() external nonReentrant only(stakeManager) returns (uint256 amount) {
        uint64 eth = uint64(block.chainid);
        uint256 l = _liquidity[eth];
        amount = rewardPot < l ? rewardPot : l;
        rewardPot -= amount;
        _liquidity[eth] = l - amount;
        emit RewardPotTaken(amount);
        if (amount > 0) usdc.safeTransfer(stakeManager, amount);
    }

    // ================================================================== balances

    /// @inheritdoc ILiquidityManager
    /// @dev Pays min(claimable, L[ETH]); the rest stays claimable.
    function claim() external nonReentrant {
        uint256 owed = claimable[msg.sender];
        if (owed == 0) revert ZeroAmount();
        uint64 eth = uint64(block.chainid);
        uint256 l = _liquidity[eth];
        uint256 pay = owed < l ? owed : l;
        if (pay == 0) revert InsufficientLiquidity(eth);
        claimable[msg.sender] = owed - pay;
        totalClaimable -= pay;
        _liquidity[eth] = l - pay;
        emit Claimed(msg.sender, pay);
        usdc.safeTransfer(msg.sender, pay);
    }

    // ================================================================== LPs

    /// @inheritdoc ILiquidityManager
    function addLiquidity(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (hub.inflowsPaused()) revert InflowsPaused();
        if (receiver == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();
        shares = previewAdd(assets);
        if (shares == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        lpAssets += assets;
        _liquidity[uint64(block.chainid)] += assets;
        _mint(receiver, shares);
        emit LiquidityAdded(msg.sender, receiver, assets, shares);
    }

    /// @inheritdoc ILiquidityManager
    /// @dev Never pausable. Requires L[ETH] >= assets and the global safety valve (PRD 9.6) to
    ///      still hold after the withdrawal: unconfirmedFastValue <= beta * (lpAssets - assets + insurance).
    function removeLiquidity(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        assets = previewRemove(shares);
        if (assets == 0) revert ZeroAmount();
        uint64 eth = uint64(block.chainid);
        uint256 l = _liquidity[eth];
        if (l < assets) revert InsufficientLiquidity(eth);
        _checkSafetyValve(lpAssets - assets + insurance);

        _burn(msg.sender, shares);
        lpAssets -= assets;
        _liquidity[eth] = l - assets;
        emit LiquidityRemoved(msg.sender, receiver, assets, shares);
        usdc.safeTransfer(receiver, assets);
    }

    /// @inheritdoc ILiquidityManager
    function previewAdd(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + _VIRTUAL_SHARES, lpAssets + _VIRTUAL_ASSETS);
    }

    /// @inheritdoc ILiquidityManager
    function previewRemove(uint256 shares) public view returns (uint256) {
        uint256 a = Math.mulDiv(shares, lpAssets + _VIRTUAL_ASSETS, totalSupply() + _VIRTUAL_SHARES);
        return a < lpAssets ? a : lpAssets;
    }

    // ================================================================== rebalancing (PRD 11.3)

    /// @inheritdoc ILiquidityManager
    function rebalance(uint64 srcChainId, uint64 dstChainId, uint256 amount, BridgeParams calldata bp)
        external
        payable
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        _requireSupported(srcChainId);
        _requireSupported(dstChainId);
        if (srcChainId == dstChainId || amount < minRebalance) revert RebalancePolicy();

        uint256 total = _totalLiquidity();
        uint256 lSrc = _liquidity[srcChainId];
        uint256 lDst = _liquidity[dstChainId];
        // Source surplus: target rounded up (against the mover); destination deficit: rounded down.
        uint256 tSrc = Math.mulDiv(_targetBps[srcChainId], total, _BPS, Math.Rounding.Ceil);
        uint256 tDst = Math.mulDiv(_targetBps[dstChainId], total, _BPS);
        if (lSrc < amount || lSrc - amount < tSrc) revert RebalancePolicy();
        if (lDst >= tDst || amount > tDst - lDst) revert RebalancePolicy();

        uint64 eth = uint64(block.chainid);
        uint64 nonce = ++rebalanceNonce;
        _liquidity[srcChainId] = lSrc - amount;
        _liquidity[dstChainId] = lDst + amount - REBALANCE_MAX_FEE;
        emit Rebalanced(srcChainId, dstChainId, amount, REBALANCE_MAX_FEE, nonce);

        if (srcChainId == eth) {
            if (msg.value != 0) revert UnexpectedValue();
            usdc.forceApprove(address(tokenMessenger), amount);
            tokenMessenger.depositForBurn(
                amount,
                _domainOf(dstChainId),
                _toBytes32(_spokeOf(dstChainId)),
                address(usdc),
                bytes32(0),
                REBALANCE_MAX_FEE,
                REBALANCE_MIN_FINALITY
            );
        } else {
            bytes32 mintRecipient = dstChainId == eth ? _toBytes32(address(this)) : _toBytes32(_spokeOf(dstChainId));
            RebalanceOrder memory order = RebalanceOrder({
                amount: amount,
                dstDomain: _domainOf(dstChainId),
                mintRecipient: mintRecipient,
                maxFee: REBALANCE_MAX_FEE,
                minFinality: REBALANCE_MIN_FINALITY,
                nonce: nonce
            });
            IHubAdapter(_adapterOf(srcChainId)).sendToSpoke{value: msg.value}(
                abi.encode(MSG_REBALANCE, abi.encode(order)), bp
            );
        }
    }

    // ================================================================== guardian (bounded)

    /// @inheritdoc ILiquidityManager
    function setTargets(uint256 ethBps, uint256 baseBps, uint256 arbBps) external nonReentrant {
        address g = hub.guardian();
        if (g == address(0) || msg.sender != g) revert OnlyGuardian();
        _checkTargets(targetBpsMin, targetBpsMax, ethBps, baseBps, arbBps);
        _targetBps[uint64(block.chainid)] = ethBps;
        _targetBps[baseChainId] = baseBps;
        _targetBps[arbChainId] = arbBps;
        emit TargetsUpdated(ethBps, baseBps, arbBps);
    }

    // ================================================================== views

    function available(uint64 chainId) external view returns (uint256) {
        return _liquidity[chainId];
    }

    function totalLiquidity() external view returns (uint256) {
        return _totalLiquidity();
    }

    function target(uint64 chainId) external view returns (uint256) {
        return Math.mulDiv(_targetBps[chainId], _totalLiquidity(), _BPS);
    }

    function targetBps(uint64 chainId) external view returns (uint256) {
        return _targetBps[chainId];
    }

    // ================================================================== internal

    function _totalLiquidity() internal view returns (uint256) {
        return _liquidity[uint64(block.chainid)] + _liquidity[baseChainId] + _liquidity[arbChainId];
    }

    function _requireSupported(uint64 chainId) internal view {
        if (chainId != block.chainid && chainId != baseChainId && chainId != arbChainId) {
            revert UnsupportedChain(chainId);
        }
    }

    function _spokeOf(uint64 chainId) internal view returns (address) {
        return chainId == baseChainId ? baseSpoke : arbSpoke; // only called for L2 chain ids
    }

    function _adapterOf(uint64 chainId) internal view returns (address) {
        return chainId == baseChainId ? baseAdapter : arbAdapter; // only called for L2 chain ids
    }

    function _domainOf(uint64 chainId) internal view returns (uint32) {
        if (chainId == baseChainId) return baseDomain;
        if (chainId == arbChainId) return arbDomain;
        return ethDomain;
    }

    function _toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _checkTargets(uint256 lo, uint256 hi, uint256 e, uint256 b, uint256 a) internal pure {
        if (e < lo || e > hi || b < lo || b > hi || a < lo || a > hi || e + b + a != _BPS) revert OutOfBounds();
    }

    /// @dev Fails closed: if DepositManager.beta() is missing or malformed, LP removals revert while
    ///      unconfirmed fast-lane value is outstanding (they always succeed when it is zero).
    function _checkSafetyValve(uint256 backingAfter) internal view {
        uint256 ufv = IDepositManager(depositManager).unconfirmedFastValue();
        if (ufv == 0) return;
        (bool ok, bytes memory ret) = depositManager.staticcall(abi.encodeWithSelector(_BETA_SELECTOR));
        if (!ok || ret.length < 64) revert SafetyValve();
        (uint256 num, uint256 den) = abi.decode(ret, (uint256, uint256));
        if (den == 0) revert SafetyValve();
        // ufv <= num/den * backingAfter  <=>  ufv * den <= num * backingAfter (overflow reverts: fail closed)
        if (ufv * den > num * backingAfter) revert SafetyValve();
    }

    /// @dev ERC-20 transfer that reports failure instead of reverting (blacklist, short balance).
    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return address(usdc).code.length > 0;
        return ret.length >= 32 && abi.decode(ret, (bool));
    }
}
