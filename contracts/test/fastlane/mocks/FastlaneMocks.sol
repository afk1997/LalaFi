// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDepositManager} from "../../../src/interfaces/IDepositManager.sol";

/// @notice HubCore test double: records inserted deposit leaves, guardian and the inflow flag.
contract MockHubCore {
    error OnlyDepositManager();

    address public guardian;
    bool public inflowsPaused;
    address public depositManager;
    uint256 public shieldedSupply;
    uint32 public nextLeafIndex;
    uint256[] public leaves; // includes Z0 padding (recorded as 0)
    uint256 public insertCalls;

    constructor(address guardian_) {
        guardian = guardian_;
    }

    function setDepositManager(address dm) external {
        depositManager = dm;
    }

    function setGuardian(address g) external {
        guardian = g;
    }

    function setInflowsPaused(bool p) external {
        inflowsPaused = p;
    }

    function insertDepositLeaves(uint256[] calldata commitments, uint256 totalAmount)
        external
        returns (uint32 firstLeafIndex)
    {
        if (msg.sender != depositManager) revert OnlyDepositManager();
        firstLeafIndex = nextLeafIndex;
        uint256 n = commitments.length;
        for (uint256 i; i < n; ++i) {
            leaves.push(commitments[i]);
        }
        if (n % 2 == 1) leaves.push(0);
        nextLeafIndex = uint32(leaves.length);
        shieldedSupply += totalAmount;
        ++insertCalls;
    }

    function leafCount() external view returns (uint256) {
        return leaves.length;
    }
}

/// @notice LiquidityManager test double: ledger, bounties, slashed-stake intake, reward pot and an
///         LP-exit safety valve that staticcalls DepositManager.beta() like the real one.
contract MockLiquidityManager {
    error Unauthorized();
    error SafetyValve();

    IERC20 public immutable usdc;
    address public depositManager;
    address public stakeManager;

    mapping(uint64 => uint256) public available;
    mapping(uint64 => uint256) public creditedByDM;
    mapping(address => uint256) public claimable;
    uint256 public totalClaimable;
    uint256 public lpAssets;
    uint256 public insurance;
    uint256 public rewardPot;
    uint256 public totalSlashedReceived;
    uint256 public creditCalls;
    bool public revertTakePot;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function setManagers(address dm, address sm) external {
        depositManager = dm;
        stakeManager = sm;
    }

    function setLpAssets(uint256 a) external {
        lpAssets = a;
    }

    function setInsurance(uint256 a) external {
        insurance = a;
    }

    function setRevertTakePot(bool r) external {
        revertTakePot = r;
    }

    function credit(uint64 chainId, uint256 amount) external {
        if (msg.sender != depositManager) revert Unauthorized();
        available[chainId] += amount;
        creditedByDM[chainId] += amount;
        ++creditCalls;
    }

    function creditBounty(address to, uint256 amount) external {
        if (msg.sender != depositManager) revert Unauthorized();
        claimable[to] += amount;
        totalClaimable += amount;
    }

    function receiveSlashed(uint256 amount) external {
        if (msg.sender != stakeManager) revert Unauthorized();
        insurance += amount;
        available[uint64(block.chainid)] += amount;
        totalSlashedReceived += amount;
    }

    function fundRewardPot(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        rewardPot += amount;
    }

    function takeRewardPot() external returns (uint256 amount) {
        if (msg.sender != stakeManager) revert Unauthorized();
        require(!revertTakePot, "pot");
        amount = rewardPot;
        rewardPot = 0;
        if (amount != 0) usdc.transfer(stakeManager, amount);
    }

    function addLiquidity(uint256 assets) external {
        usdc.transferFrom(msg.sender, address(this), assets);
        lpAssets += assets;
    }

    /// @dev PRD 9.6 on LP redemption: unconfirmedFastValue ≤ β·(lpAssets − assets + insurance).
    function removeLiquidity(uint256 assets) external {
        (uint256 num, uint256 den) = IBeta(depositManager).beta();
        uint256 u = IDepositManager(depositManager).unconfirmedFastValue();
        if (den * u > num * (lpAssets - assets + insurance)) revert SafetyValve();
        lpAssets -= assets;
        usdc.transfer(msg.sender, assets);
    }
}

interface IBeta {
    function beta() external view returns (uint256 num, uint256 den);
}

/// @notice Hub adapter test double: forwards an (already authenticated) checkpoint body.
contract MockHubAdapter {
    IDepositManager public depositManager;
    uint64 public immutable spokeChainId;

    constructor(uint64 chainId) {
        spokeChainId = chainId;
    }

    function setDepositManager(address dm) external {
        depositManager = IDepositManager(dm);
    }

    function deliver(bytes calldata body) external {
        depositManager.receiveCheckpoint(spokeChainId, body);
    }
}
