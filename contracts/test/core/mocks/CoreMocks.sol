// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHubCore} from "../../../src/interfaces/IHubCore.sol";
import {ILiquidityManager} from "../../../src/interfaces/ILiquidityManager.sol";
import {IHubAdapter} from "../../../src/interfaces/IHubAdapter.sol";
import {ITokenMessengerV2} from "../../../src/interfaces/external/ICCTP.sol";
import {BridgeParams, Release, MSG_RELEASE} from "../../../src/libraries/Types.sol";
import {MockUSDC} from "../../../src/mocks/MockUSDC.sol";

/// @notice Test double for DepositManager: forwards to HubCore / LiquidityManager and exposes the
///         two views LiquidityManager reads (unconfirmedFastValue, beta).
contract CoreMockDepositManager {
    IHubCore public hub;
    ILiquidityManager public lm;
    uint256 public unconfirmedFastValue;
    uint256 internal _betaNum = 1;
    uint256 internal _betaDen = 2;
    bool public betaMissing;

    function wire(address hub_, address lm_) external {
        hub = IHubCore(hub_);
        lm = ILiquidityManager(lm_);
    }

    function setUnconfirmedFastValue(uint256 v) external {
        unconfirmedFastValue = v;
    }

    function setBeta(uint256 num, uint256 den) external {
        _betaNum = num;
        _betaDen = den;
    }

    function setBetaMissing(bool m) external {
        betaMissing = m;
    }

    function beta() external view returns (uint256, uint256) {
        require(!betaMissing);
        return (_betaNum, _betaDen);
    }

    function insert(uint256[] calldata commitments, uint256 total) external returns (uint32) {
        return hub.insertDepositLeaves(commitments, total);
    }

    function credit(uint64 chainId, uint256 amount) external {
        lm.credit(chainId, amount);
    }

    function creditBounty(address to, uint256 amount) external {
        lm.creditBounty(to, amount);
    }
}

/// @notice Test double for StakeManager: moves slashed USDC in and takes the reward pot.
contract CoreMockStakeManager {
    ILiquidityManager public lm;
    MockUSDC public usdc;

    function wire(address lm_, address usdc_) external {
        lm = ILiquidityManager(lm_);
        usdc = MockUSDC(usdc_);
    }

    function slashIn(uint256 amount) external {
        usdc.mint(address(this), amount);
        IERC20(address(usdc)).transfer(address(lm), amount);
        lm.receiveSlashed(amount);
    }

    function take() external returns (uint256) {
        return lm.takeRewardPot();
    }
}

/// @notice Test double for a hub adapter. `arbStyle` requires msg.value >= minValue, otherwise
///         msg.value must be 0 (OP). Records every message; models spoke-side idempotent release
///         execution (each index executes at most once).
contract CoreMockAdapter {
    error InsufficientValue();
    error Unauthorized();

    struct Sent {
        bytes message;
        uint256 value;
        BridgeParams bp;
        address caller;
    }

    bool public immutable arbStyle;
    uint256 public minValue;
    Sent[] internal _sent;
    address[] public allowedCallers;

    mapping(uint64 => bool) public executed;
    mapping(uint64 => uint256) public execCount;
    mapping(uint64 => Release) internal _releases;
    uint64 public uniqueExecuted;

    constructor(bool arbStyle_) {
        arbStyle = arbStyle_;
    }

    function setMinValue(uint256 v) external {
        minValue = v;
    }

    function allow(address a) external {
        allowedCallers.push(a);
    }

    function sendToSpoke(bytes calldata message, BridgeParams calldata bp) external payable {
        bool ok;
        for (uint256 i; i < allowedCallers.length; ++i) {
            if (allowedCallers[i] == msg.sender) ok = true;
        }
        if (!ok) revert Unauthorized();
        if (arbStyle ? msg.value < minValue : msg.value != 0) revert InsufficientValue();
        _sent.push(Sent({message: message, value: msg.value, bp: bp, caller: msg.sender}));
        (uint8 kind, bytes memory body) = abi.decode(message, (uint8, bytes));
        if (kind == MSG_RELEASE) {
            Release memory r = abi.decode(body, (Release));
            if (!executed[r.index]) {
                executed[r.index] = true;
                execCount[r.index] += 1;
                _releases[r.index] = r;
                uniqueExecuted += 1;
            }
        }
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sent(uint256 i)
        external
        view
        returns (bytes memory message, uint256 value, BridgeParams memory bp, address caller)
    {
        Sent storage s = _sent[i];
        return (s.message, s.value, s.bp, s.caller);
    }

    function lastMessage() external view returns (uint8 kind, bytes memory body) {
        return abi.decode(_sent[_sent.length - 1].message, (uint8, bytes));
    }

    function lastValue() external view returns (uint256) {
        return _sent[_sent.length - 1].value;
    }

    function releaseAt(uint64 index) external view returns (Release memory) {
        return _releases[index];
    }
}

/// @notice Test double for CCTP V2 TokenMessenger: pulls (burns) the USDC and records the call.
contract CoreMockTokenMessenger is ITokenMessengerV2 {
    struct Burn {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
    }

    Burn[] public burns;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        burns.push(
            Burn(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold)
        );
    }

    function burnCount() external view returns (uint256) {
        return burns.length;
    }
}

/// @notice Adapter that re-enters HubCore while handling a send.
contract ReentrantAdapter {
    IHubCore public hub;
    bytes public lastError;

    function setHub(address h) external {
        hub = IHubCore(h);
    }

    function sendToSpoke(bytes calldata message, BridgeParams calldata bp) external payable {
        (, bytes memory body) = abi.decode(message, (uint8, bytes));
        Release memory r = abi.decode(body, (Release));
        hub.resendRelease(r, bp); // must revert (nonReentrant)
    }
}
