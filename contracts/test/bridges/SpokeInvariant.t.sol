// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockArbSys} from "../../src/mocks/MockArbSys.sol";
import {MockTokenMessengerV2} from "../../src/mocks/MockTokenMessengerV2.sol";
import {ArbitrumSpoke} from "../../src/spoke/ArbitrumSpoke.sol";
import {ISpoke} from "../../src/interfaces/ISpoke.sol";
import {SpokeConfig} from "../../src/libraries/DeployConfig.sol";
import {AddressAliasHelper, ARB_SYS} from "../../src/interfaces/external/IArbitrum.sol";
import {MSG_RELEASE, MSG_REBALANCE, Release, RebalanceOrder} from "../../src/libraries/Types.sol";

/// @notice Plays the hub (ledger L for this spoke, reservations, in-flight mints) and the bridge
///         (delayed, duplicated, reordered delivery) against one spoke.
contract SpokeHandler is Test {
    MockUSDC public usdc;
    ArbitrumSpoke public spoke;
    address public adapterAlias;
    address public user = makeAddr("inv-user");
    address[3] public recipients = [makeAddr("r0"), makeAddr("r1"), makeAddr("r2")];

    // hub-side model
    uint256 public L; // ledger L[c]
    uint256 public M; // CCTP mints in flight toward the spoke
    uint256 public undelivered; // reserved outflows not yet delivered to the spoke
    uint256 public totalIn; // every USDC unit that ever entered the spoke
    uint256[] public unconfirmed; // deposit amounts (incl. fee) not yet in L

    struct Msg {
        bool isRelease;
        uint64 id;
        uint256 amount;
        address recipient;
        bool delivered;
    }

    Msg[] public msgs;
    uint64 public nextReleaseIndex;
    uint64 public nextNonce;
    uint256 internal fee;
    bool public i8Violated;

    /// @dev Deploys the token itself so it is the MockUSDC admin (blacklisting).
    constructor(address adapter) {
        usdc = new MockUSDC();
        MockTokenMessengerV2 tm = new MockTokenMessengerV2(address(usdc), 3);
        usdc.setMinter(address(tm), true);
        spoke = new ArbitrumSpoke(
            SpokeConfig({
                usdc: address(usdc),
                hubChainId: 31337,
                hubAdapter: adapter,
                tokenMessengerV2: address(tm),
                minDeposit: 1e6,
                maxDeposit: 1e9,
                tvlCap: type(uint128).max,
                settleFeeInsert: 75_000,
                settleFeeFinal: 25_000,
                maxCheckpoint: 64,
                minEmptyCheckpointInterval: 5,
                minGasL1: 0
            })
        );
        adapterAlias = AddressAliasHelper.applyL1ToL2Alias(adapter);
        fee = spoke.settleFeeInsert() + spoke.settleFeeFinal();
        usdc.mint(user, type(uint128).max);
        vm.prank(user);
        usdc.approve(address(spoke), type(uint256).max);
    }

    function msgCount() external view returns (uint256) {
        return msgs.length;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, spoke.minDeposit(), 50e6);
        vm.prank(user);
        try spoke.deposit(amount, 1, "") {
            unconfirmed.push(amount + fee);
            totalIn += amount + fee;
        } catch {}
    }

    function confirm(uint256 n) external {
        n = bound(n, 0, unconfirmed.length);
        for (uint256 i; i < n; ++i) {
            L += unconfirmed[unconfirmed.length - 1];
            unconfirmed.pop();
        }
    }

    function logRelease(uint256 amount, uint256 r) external {
        if (L == 0) return;
        amount = bound(amount, 1, L);
        L -= amount;
        undelivered += amount;
        msgs.push(Msg(true, nextReleaseIndex++, amount, recipients[r % 3], false));
    }

    function orderBurn(uint256 amount) external {
        if (L == 0) return;
        amount = bound(amount, 1, L);
        L -= amount;
        undelivered += amount;
        msgs.push(Msg(false, nextNonce++, amount, address(0), false));
    }

    function inboundRebalance(uint256 amount) external {
        amount = bound(amount, 1, 100e6);
        L += amount; // counted at burn on the source
        M += amount;
    }

    function landMint(uint256 amount) external {
        if (M == 0) return;
        amount = bound(amount, 1, M);
        M -= amount;
        usdc.mint(address(spoke), amount);
        totalIn += amount;
    }

    /// @dev Delivers any message: first delivery, or a duplicate (resend / replay).
    function deliver(uint256 i) external {
        if (msgs.length == 0) return;
        Msg storage m = msgs[i % msgs.length];
        bytes memory envelope = m.isRelease
            ? abi.encode(
                MSG_RELEASE,
                abi.encode(
                    Release({
                        dstChainId: uint64(block.chainid),
                        index: m.id,
                        recipient: m.recipient,
                        amount: m.amount,
                        spendId: 0
                    })
                )
            )
            : abi.encode(
                MSG_REBALANCE,
                abi.encode(
                    RebalanceOrder({
                        amount: m.amount,
                        dstDomain: 0,
                        mintRecipient: bytes32(uint256(1)),
                        maxFee: 0,
                        minFinality: 2000,
                        nonce: m.id
                    })
                )
            );
        vm.prank(adapterAlias);
        spoke.receiveFromHub(envelope);
        if (!m.delivered) {
            m.delivered = true;
            undelivered -= m.amount;
        }
    }

    /// @dev A non-canonical caller tries to inject a release (I8). Must always revert.
    function inject(address caller, uint256 amount) external {
        if (caller == adapterAlias) return;
        bytes memory envelope = abi.encode(
            MSG_RELEASE,
            abi.encode(
                Release({
                    dstChainId: uint64(block.chainid),
                    index: nextReleaseIndex + 1000,
                    recipient: caller,
                    amount: bound(amount, 1, 1e9),
                    spendId: 0
                })
            )
        );
        vm.prank(caller);
        try spoke.receiveFromHub(envelope) {
            i8Violated = true; // fail_on_revert is off, so record instead of reverting
        } catch {}
    }

    function processQueue(uint256 n) external {
        spoke.processQueue(bound(n, 0, 20));
    }

    function toggleBlacklist(uint256 r) external {
        address a = recipients[r % 3];
        usdc.setBlacklisted(a, !usdc.isBlacklisted(a));
    }

    function retry(uint256 i) external {
        if (msgs.length == 0) return;
        Msg storage m = msgs[i % msgs.length];
        if (m.isRelease) {
            try spoke.retryFailedRelease(m.id) {} catch {}
        } else {
            try spoke.retryFailedRebalance(m.id) {} catch {}
        }
    }
}

contract SpokeInvariantTest is Test {
    MockUSDC internal usdc;
    ArbitrumSpoke internal spoke;
    SpokeHandler internal handler;
    address internal adapter = makeAddr("adapter");

    function setUp() public {
        vm.etch(ARB_SYS, type(MockArbSys).runtimeCode);
        handler = new SpokeHandler(adapter);
        usdc = handler.usdc();
        spoke = handler.spoke();
        targetContract(address(handler));
    }

    /// I4: V + M >= L + Q for the spoke.
    function invariant_I4_liquidity() public view {
        uint256 V = usdc.balanceOf(address(spoke));
        uint256 Q = handler.undelivered() + spoke.queuedAmount() + spoke.failedAmount();
        assertGe(V + handler.M(), handler.L() + Q, "I4");
    }

    /// I8: only the canonical (aliased) adapter can deliver.
    function invariant_I8_onlyCanonical() public view {
        assertFalse(handler.i8Violated(), "I8");
    }

    /// I7 + conservation: every unit that left the spoke left through exactly one executed release
    /// or burn; nothing executed twice; queued/failed bookkeeping matches the states.
    function invariant_I7_atMostOnce() public view {
        uint256 executed;
        uint256 queued;
        uint256 failed;
        uint256 n = handler.msgCount();
        for (uint256 i; i < n; ++i) {
            (bool isRelease, uint64 id, uint256 amount,,) = handler.msgs(i);
            ISpoke.ReleaseState s = isRelease ? spoke.releaseState(id) : spoke.rebalanceState(id);
            if (s == ISpoke.ReleaseState.Executed) executed += amount;
            else if (s == ISpoke.ReleaseState.Queued) queued += amount;
            else if (s == ISpoke.ReleaseState.Failed) failed += amount;
        }
        assertEq(usdc.balanceOf(address(spoke)), handler.totalIn() - executed, "conservation");
        assertEq(spoke.queuedAmount(), queued, "queuedAmount");
        assertEq(spoke.failedAmount(), failed, "failedAmount");
        uint256 received;
        for (uint256 r; r < 3; ++r) {
            received += usdc.balanceOf(handler.recipients(r));
        }
        assertLe(received, executed, "recipients");
    }
}
