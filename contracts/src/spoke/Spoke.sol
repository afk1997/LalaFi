// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ISpoke} from "../interfaces/ISpoke.sol";
import {ITokenMessengerV2} from "../interfaces/external/ICCTP.sol";
import {SpokeConfig} from "../libraries/DeployConfig.sol";
import {
    P,
    MAX_ENC_LEN,
    MSG_RELEASE,
    MSG_REBALANCE,
    MSG_PAUSE,
    MSG_CHECKPOINT,
    Release,
    RebalanceOrder,
    L2Deposit,
    Checkpoint
} from "../libraries/Types.sol";

/// @title Spoke (PRD 7.8): the L2 vault on Base / Arbitrum.
/// @notice Holds user USDC on the L2. Records deposits (no Poseidon), sends canonical checkpoints
///         to the hub, executes hub releases, burns through CCTP on hub rebalance orders and honours
///         the hub's deposit pause. No owner, no admin, no upgradeability.
/// @dev Liquidity accounting (I4: V + M >= L + Q). Every outflow the hub has already reserved but that
///      has not left the vault yet (queued releases, queued burns, failed releases / burns) is tracked in
///      `queuedAmount` / `failedAmount`. A *new* outflow executes immediately only if the balance covers
///      it on top of every existing reservation; otherwise it joins the FIFO outflow queue. So queued
///      items are always paid before later arrivals can use the balance.
///
///      receiveFromHub never reverts on application errors: decoding runs in a self-staticcall wrapped
///      in try/catch, and the USDC transfer / CCTP burn are low-level calls whose failure is recorded.
///      It only reverts when (a) the caller is not the canonical bridge carrying the hub adapter, or
///      (b) the bridge forwarded less than MIN_HUB_MESSAGE_GAS, so the delivery stays replayable
///      instead of being consumed by an out-of-gas inner call.
abstract contract Spoke is ISpoke, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants
    /// @dev Gas the bridge must forward into receiveFromHub (covers a CCTP burn, the most expensive action).
    uint256 public constant MIN_HUB_MESSAGE_GAS = 220_000;
    /// @dev Gas kept back per queued release / burn inside processQueue (anti OOG-griefing).
    uint256 public constant RELEASE_ITEM_GAS = 100_000;
    uint256 public constant BURN_ITEM_GAS = 200_000;
    /// @dev Upper bound for maxCheckpoint (keeps sendCheckpoint and the L1 receive well inside block limits).
    uint64 public constant MAX_CHECKPOINT_BOUND = 256;

    // ------------------------------------------------------------------ extra errors / events
    error ZeroAddress();
    error BadConfig();
    error InsufficientGas();
    error ReleaseTransferFailed();
    error RebalanceBurnFailed(bytes reason);
    /// @dev Encoded into HubMessageIgnored.reason.
    error UnknownKind(uint8 kind);
    error WrongDestination(uint64 dstChainId);
    error AlreadyHandled(uint64 id);
    error RebalanceDisabled(uint64 nonce);

    event RebalanceQueued(uint64 indexed nonce);
    event RebalanceFailed(uint64 indexed nonce, bytes reason);

    // ------------------------------------------------------------------ types
    enum OutflowKind {
        None,
        Release,
        Rebalance
    }

    struct PackedDeposit {
        uint256 ownerDigest;
        uint128 amount;
        uint64 fee;
        uint64 l2Block;
    }

    struct ReleaseRecord {
        ReleaseState state; // packed with recipient
        address recipient;
        uint256 amount;
    }

    struct RebalanceRecord {
        ReleaseState state; // None / Executed / Queued / Failed (same lifecycle as releases)
        RebalanceOrder order;
    }

    struct QueueItem {
        OutflowKind kind;
        uint64 id; // release index or rebalance nonce
    }

    // ------------------------------------------------------------------ immutables
    address public immutable override usdc;
    uint64 public immutable override hubChainId;
    address public immutable override hubAdapter;
    address public immutable tokenMessengerV2;
    uint256 public immutable override minDeposit;
    uint256 public immutable override maxDeposit;
    uint256 public immutable tvlCap;
    uint256 public immutable override settleFeeInsert;
    uint256 public immutable override settleFeeFinal;
    uint64 public immutable maxCheckpoint;
    uint64 public immutable minEmptyCheckpointInterval;
    uint32 public immutable minGasL1;
    uint256 internal immutable _settleFee;

    // ------------------------------------------------------------------ deposit / checkpoint state
    mapping(uint64 => PackedDeposit) internal _deposits;
    uint64 public override depositCount;
    uint64 public override nextCheckpointFrom;
    uint64 public override checkpointSeq;
    /// @dev l2 block from which the next empty checkpoint is allowed.
    uint64 public nextEmptyCheckpointBlock;
    bool public override depositsPaused;

    // ------------------------------------------------------------------ outflow state
    mapping(uint64 => ReleaseRecord) internal _releases;
    mapping(uint64 => RebalanceRecord) internal _rebalances;
    mapping(uint256 => QueueItem) internal _queue;
    uint256 public queueHead;
    uint256 public queueTail;
    /// @dev Sum of queued releases + queued burns.
    uint256 public queuedAmount;
    /// @dev Sum of failed releases + failed burns (still owed; reserved).
    uint256 public failedAmount;

    constructor(SpokeConfig memory cfg) {
        // tokenMessengerV2 == 0: no CCTP for this pool's token (e.g. DAI); rebalance orders are ignored.
        if (cfg.usdc == address(0) || cfg.hubAdapter == address(0)) revert ZeroAddress();
        if (
            cfg.hubChainId == 0 || cfg.minDeposit == 0 || cfg.minDeposit > cfg.maxDeposit
                || cfg.maxDeposit > type(uint128).max || cfg.maxCheckpoint == 0
                || cfg.maxCheckpoint > MAX_CHECKPOINT_BOUND || cfg.settleFeeInsert + cfg.settleFeeFinal > type(uint64).max
                || cfg.tvlCap < cfg.maxDeposit
        ) revert BadConfig();
        usdc = cfg.usdc;
        hubChainId = cfg.hubChainId;
        hubAdapter = cfg.hubAdapter;
        tokenMessengerV2 = cfg.tokenMessengerV2;
        minDeposit = cfg.minDeposit;
        maxDeposit = cfg.maxDeposit;
        tvlCap = cfg.tvlCap;
        settleFeeInsert = cfg.settleFeeInsert;
        settleFeeFinal = cfg.settleFeeFinal;
        maxCheckpoint = cfg.maxCheckpoint;
        minEmptyCheckpointInterval = cfg.minEmptyCheckpointInterval;
        minGasL1 = cfg.minGasL1;
        _settleFee = cfg.settleFeeInsert + cfg.settleFeeFinal;
    }

    // ================================================================== chain hooks
    /// @dev Canonical-origin check for hub -> spoke messages.
    function _isFromHub() internal view virtual returns (bool);
    /// @dev Canonical spoke -> hub send to `hubAdapter` carrying IHubAdapter.receiveFromSpoke(message).
    function _sendToHub(bytes memory message) internal virtual;
    /// @dev L2 block clock shared by deposits and checkpoints.
    function _l2BlockNumber() internal view virtual returns (uint64);

    // ================================================================== deposits
    /// @inheritdoc ISpoke
    function deposit(uint256 amount, uint256 ownerDigest, bytes calldata encNote) external override nonReentrant {
        if (depositsPaused) revert DepositsPaused();
        if (amount < minDeposit || amount > maxDeposit) revert BadAmount();
        if (ownerDigest >= P) revert FieldOverflow();
        if (encNote.length > MAX_ENC_LEN) revert EncNoteTooLong();
        uint256 fee = _settleFee;
        uint256 total = amount + fee;
        if (IERC20(usdc).balanceOf(address(this)) + total > tvlCap) revert TvlCapExceeded();

        uint64 index = depositCount;
        depositCount = index + 1;
        uint64 l2b = _l2BlockNumber();
        // amount <= maxDeposit <= uint128.max and fee <= uint64.max are enforced in the constructor.
        _deposits[index] =
            PackedDeposit({ownerDigest: ownerDigest, amount: uint128(amount), fee: uint64(fee), l2Block: l2b});
        emit Deposit(index, ownerDigest, amount, fee, l2b, encNote);

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), total);
    }

    // ================================================================== checkpoints
    /// @inheritdoc ISpoke
    function sendCheckpoint() external override nonReentrant {
        uint64 from = nextCheckpointFrom;
        uint64 count = depositCount;
        uint64 to = count - from > maxCheckpoint ? from + maxCheckpoint : count;
        uint64 l2b = _l2BlockNumber();
        if (to == from) {
            if (l2b < nextEmptyCheckpointBlock) revert EmptyCheckpointTooSoon();
            nextEmptyCheckpointBlock = l2b + minEmptyCheckpointInterval;
        }
        uint64 seq = checkpointSeq;
        checkpointSeq = seq + 1;
        nextCheckpointFrom = to;

        L2Deposit[] memory items = new L2Deposit[](to - from);
        for (uint64 k; k < to - from; ++k) {
            PackedDeposit storage d = _deposits[from + k];
            items[k] = L2Deposit({
                index: from + k, ownerDigest: d.ownerDigest, amount: d.amount, fee: d.fee, l2Block: d.l2Block
            });
        }
        Checkpoint memory cp =
            Checkpoint({seq: seq, from: from, to: to, countAtSend: count, l2Block: l2b, deposits: items});
        emit CheckpointSent(seq, from, to, count, l2b);
        _sendToHub(abi.encode(MSG_CHECKPOINT, abi.encode(cp)));
    }

    // ================================================================== hub messages
    /// @inheritdoc ISpoke
    function receiveFromHub(bytes calldata message) external override nonReentrant {
        if (!_isFromHub()) revert NotFromHub();
        if (gasleft() < MIN_HUB_MESSAGE_GAS) revert InsufficientGas();

        uint8 kind;
        bytes memory body;
        try this.decodeEnvelope(message) returns (uint8 k, bytes memory b) {
            kind = k;
            body = b;
        } catch (bytes memory reason) {
            emit HubMessageIgnored(0, reason);
            return;
        }

        if (kind == MSG_RELEASE) {
            try this.decodeRelease(body) returns (Release memory r) {
                _onRelease(r);
            } catch (bytes memory reason) {
                emit HubMessageIgnored(kind, reason);
            }
        } else if (kind == MSG_REBALANCE) {
            try this.decodeRebalance(body) returns (RebalanceOrder memory o) {
                _onRebalance(o);
            } catch (bytes memory reason) {
                emit HubMessageIgnored(kind, reason);
            }
        } else if (kind == MSG_PAUSE) {
            try this.decodePause(body) returns (bool paused) {
                depositsPaused = paused;
                emit DepositsPausedSet(paused);
            } catch (bytes memory reason) {
                emit HubMessageIgnored(kind, reason);
            }
        } else {
            emit HubMessageIgnored(kind, abi.encodeWithSelector(UnknownKind.selector, kind));
        }
    }

    function _onRelease(Release memory r) internal {
        if (r.dstChainId != block.chainid) {
            emit HubMessageIgnored(MSG_RELEASE, abi.encodeWithSelector(WrongDestination.selector, r.dstChainId));
            return;
        }
        ReleaseRecord storage rec = _releases[r.index];
        if (rec.state != ReleaseState.None) {
            emit HubMessageIgnored(MSG_RELEASE, abi.encodeWithSelector(AlreadyHandled.selector, r.index));
            return;
        }
        if (_balance() < queuedAmount + failedAmount + r.amount) {
            rec.state = ReleaseState.Queued;
            rec.recipient = r.recipient;
            rec.amount = r.amount;
            queuedAmount += r.amount;
            _push(OutflowKind.Release, r.index);
            emit ReleaseQueued(r.index);
            return;
        }
        rec.state = ReleaseState.Executed;
        if (_tryTransfer(r.recipient, r.amount)) {
            emit ReleaseExecuted(r.index, r.recipient, r.amount);
        } else {
            rec.state = ReleaseState.Failed;
            rec.recipient = r.recipient;
            rec.amount = r.amount;
            failedAmount += r.amount;
            emit ReleaseFailed(r.index);
        }
    }

    function _onRebalance(RebalanceOrder memory o) internal {
        if (tokenMessengerV2 == address(0)) {
            // No CCTP on this deployment: nothing is reserved, recorded or moved.
            emit HubMessageIgnored(MSG_REBALANCE, abi.encodeWithSelector(RebalanceDisabled.selector, o.nonce));
            return;
        }
        RebalanceRecord storage rec = _rebalances[o.nonce];
        if (rec.state != ReleaseState.None) {
            emit HubMessageIgnored(MSG_REBALANCE, abi.encodeWithSelector(AlreadyHandled.selector, o.nonce));
            return;
        }
        rec.order = o;
        if (_balance() < queuedAmount + failedAmount + o.amount) {
            rec.state = ReleaseState.Queued;
            queuedAmount += o.amount;
            _push(OutflowKind.Rebalance, o.nonce);
            emit RebalanceQueued(o.nonce);
            return;
        }
        rec.state = ReleaseState.Executed;
        (bool ok, bytes memory reason) = _tryBurn(o);
        if (ok) {
            emit RebalanceBurn(o.nonce, o.amount, o.dstDomain, o.mintRecipient);
        } else {
            rec.state = ReleaseState.Failed;
            failedAmount += o.amount;
            emit RebalanceFailed(o.nonce, reason);
        }
    }

    // ================================================================== queue / retries
    /// @inheritdoc ISpoke
    function processQueue(uint256 maxItems) external override nonReentrant {
        uint256 head = queueHead;
        uint256 tail = queueTail;
        uint256 done;
        while (head < tail && done < maxItems) {
            QueueItem memory item = _queue[head];
            if (item.kind == OutflowKind.Release) {
                if (gasleft() < RELEASE_ITEM_GAS) break;
                ReleaseRecord storage rec = _releases[item.id];
                uint256 amount = rec.amount;
                if (_balance() < amount) break; // strict FIFO: wait for liquidity (e.g. a CCTP mint)
                delete _queue[head];
                ++head;
                queuedAmount -= amount;
                rec.state = ReleaseState.Executed;
                if (_tryTransfer(rec.recipient, amount)) {
                    emit ReleaseExecuted(item.id, rec.recipient, amount);
                } else {
                    rec.state = ReleaseState.Failed;
                    failedAmount += amount;
                    emit ReleaseFailed(item.id);
                }
            } else {
                if (gasleft() < BURN_ITEM_GAS) break;
                RebalanceRecord storage rb = _rebalances[item.id];
                RebalanceOrder memory o = rb.order;
                if (_balance() < o.amount) break;
                delete _queue[head];
                ++head;
                queuedAmount -= o.amount;
                rb.state = ReleaseState.Executed;
                (bool ok, bytes memory reason) = _tryBurn(o);
                if (ok) {
                    emit RebalanceBurn(o.nonce, o.amount, o.dstDomain, o.mintRecipient);
                } else {
                    rb.state = ReleaseState.Failed;
                    failedAmount += o.amount;
                    emit RebalanceFailed(o.nonce, reason);
                }
            }
            ++done;
        }
        queueHead = head;
    }

    /// @inheritdoc ISpoke
    function retryFailedRelease(uint64 index) external override nonReentrant {
        ReleaseRecord storage rec = _releases[index];
        if (rec.state != ReleaseState.Failed) revert NotFailed();
        uint256 amount = rec.amount;
        failedAmount -= amount;
        if (_balance() < queuedAmount + amount) {
            // The reservation moves to the back of the queue.
            rec.state = ReleaseState.Queued;
            queuedAmount += amount;
            _push(OutflowKind.Release, index);
            emit ReleaseQueued(index);
            return;
        }
        rec.state = ReleaseState.Executed;
        if (!_tryTransfer(rec.recipient, amount)) revert ReleaseTransferFailed();
        emit ReleaseExecuted(index, rec.recipient, amount);
    }

    /// @notice Permissionless; retries a rebalance burn recorded as Failed (e.g. CCTP was paused).
    function retryFailedRebalance(uint64 nonce) external nonReentrant {
        RebalanceRecord storage rb = _rebalances[nonce];
        if (rb.state != ReleaseState.Failed) revert NotFailed();
        RebalanceOrder memory o = rb.order;
        failedAmount -= o.amount;
        if (_balance() < queuedAmount + o.amount) {
            rb.state = ReleaseState.Queued;
            queuedAmount += o.amount;
            _push(OutflowKind.Rebalance, nonce);
            emit RebalanceQueued(nonce);
            return;
        }
        rb.state = ReleaseState.Executed;
        (bool ok, bytes memory reason) = _tryBurn(o);
        if (!ok) revert RebalanceBurnFailed(reason);
        emit RebalanceBurn(o.nonce, o.amount, o.dstDomain, o.mintRecipient);
    }

    // ================================================================== decoding (self-calls)
    /// @dev Pure helpers called via `this.` so malformed input lands in a catch block.
    function decodeEnvelope(bytes calldata message) external pure returns (uint8 kind, bytes memory body) {
        (kind, body) = abi.decode(message, (uint8, bytes));
    }

    function decodeRelease(bytes calldata body) external pure returns (Release memory r) {
        r = abi.decode(body, (Release));
    }

    function decodeRebalance(bytes calldata body) external pure returns (RebalanceOrder memory o) {
        o = abi.decode(body, (RebalanceOrder));
    }

    function decodePause(bytes calldata body) external pure returns (bool paused) {
        paused = abi.decode(body, (bool));
    }

    // ================================================================== internals
    function _balance() internal view returns (uint256) {
        return IERC20(usdc).balanceOf(address(this));
    }

    function _push(OutflowKind kind, uint64 id) internal {
        _queue[queueTail++] = QueueItem({kind: kind, id: id});
    }

    /// @dev Low-level USDC transfer; false on revert (blacklist, paused token) or a false return.
    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = usdc.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || (ret.length == 32 && uint256(bytes32(ret)) == 1));
    }

    /// @dev approve + depositForBurn; on failure the allowance is reset and the reason returned.
    function _tryBurn(RebalanceOrder memory o) internal returns (bool, bytes memory) {
        (bool ok, bytes memory ret) = usdc.call(abi.encodeCall(IERC20.approve, (tokenMessengerV2, o.amount)));
        if (!ok || !(ret.length == 0 || (ret.length == 32 && uint256(bytes32(ret)) == 1))) {
            return (false, ret);
        }
        try ITokenMessengerV2(tokenMessengerV2).depositForBurn(
            o.amount, o.dstDomain, o.mintRecipient, usdc, bytes32(0), o.maxFee, o.minFinality
        ) {
            return (true, "");
        } catch (bytes memory reason) {
            // best effort; a failure here leaves a harmless allowance to the trusted messenger
            (bool reset,) = usdc.call(abi.encodeCall(IERC20.approve, (tokenMessengerV2, 0)));
            reset;
            return (false, reason);
        }
    }

    // ================================================================== views
    function getDeposit(uint64 index) external view override returns (StoredDeposit memory d) {
        PackedDeposit storage p = _deposits[index];
        d = StoredDeposit({ownerDigest: p.ownerDigest, amount: p.amount, fee: p.fee, l2Block: p.l2Block});
    }

    function releaseState(uint64 index) external view override returns (ReleaseState) {
        return _releases[index].state;
    }

    function releaseInfo(uint64 index) external view returns (ReleaseState state, address recipient, uint256 amount) {
        ReleaseRecord storage r = _releases[index];
        return (r.state, r.recipient, r.amount);
    }

    function rebalanceState(uint64 nonce) external view returns (ReleaseState) {
        return _rebalances[nonce].state;
    }

    function queueLength() external view override returns (uint256) {
        return queueTail - queueHead;
    }

    /// @notice i-th pending queue entry counted from the head.
    function queueAt(uint256 i) external view returns (OutflowKind kind, uint64 id) {
        QueueItem storage q = _queue[queueHead + i];
        return (q.kind, q.id);
    }

    /// @notice USDC not reserved by queued or failed outflows.
    function freeBalance() external view returns (uint256) {
        uint256 b = _balance();
        uint256 r = queuedAmount + failedAmount;
        return b > r ? b - r : 0;
    }

    function l2BlockNumber() external view override returns (uint64) {
        return _l2BlockNumber();
    }
}
