// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";

import {HubCallerDouble, DepositManagerDouble} from "./mocks/Doubles.sol";
import {Create3Factory} from "../../src/utils/Create3Factory.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockCrossDomainMessenger} from "../../src/mocks/MockCrossDomainMessenger.sol";
import {MockInbox} from "../../src/mocks/MockInbox.sol";
import {MockOutbox} from "../../src/mocks/MockOutbox.sol";
import {MockBridge} from "../../src/mocks/MockBridge.sol";
import {MockArbSys} from "../../src/mocks/MockArbSys.sol";
import {MockTokenMessengerV2} from "../../src/mocks/MockTokenMessengerV2.sol";
import {MockMessageTransmitterV2} from "../../src/mocks/MockMessageTransmitterV2.sol";
import {OpStackSpoke} from "../../src/spoke/OpStackSpoke.sol";
import {ArbitrumSpoke} from "../../src/spoke/ArbitrumSpoke.sol";
import {OpStackHubAdapter} from "../../src/hub/adapters/OpStackHubAdapter.sol";
import {ArbitrumHubAdapter} from "../../src/hub/adapters/ArbitrumHubAdapter.sol";
import {AdapterLib} from "../../src/hub/adapters/AdapterLib.sol";
import {ISpoke} from "../../src/interfaces/ISpoke.sol";
import {IHubAdapter} from "../../src/interfaces/IHubAdapter.sol";
import {
    IMockCrossDomainMessenger,
    IMockInbox,
    IMockArbSys,
    IMockTokenMessengerV2,
    IMockMessageTransmitterV2
} from "../../src/interfaces/IMocks.sol";
import {IInbox, AddressAliasHelper, ARB_SYS} from "../../src/interfaces/external/IArbitrum.sol";
import {
    SpokeConfig, OpStackHubAdapterConfig, ArbitrumHubAdapterConfig
} from "../../src/libraries/DeployConfig.sol";
import {
    MSG_RELEASE,
    MSG_REBALANCE,
    MSG_PAUSE,
    MSG_CHECKPOINT,
    Release,
    RebalanceOrder,
    BridgeParams,
    Checkpoint
} from "../../src/libraries/Types.sol";

/// @notice hub adapter <-> mock bridges <-> spoke, all on one EVM. The test plays services/mock-bridge.
contract RoundTripTest is Test {
    uint64 internal constant BASE = 31338;
    uint64 internal constant ARB = 31339;

    address internal relayer = makeAddr("relayer");
    Vm.Wallet internal attesterW = vm.createWallet("attester");
    address internal user = makeAddr("user");
    address internal alice = makeAddr("alice");

    Create3Factory internal factory;
    MockUSDC internal usdc;
    MockCrossDomainMessenger internal l1m;
    MockCrossDomainMessenger internal l2m;
    MockInbox internal inbox;
    MockOutbox internal outbox;
    MockBridge internal bridge;
    MockTokenMessengerV2 internal tm;
    MockMessageTransmitterV2 internal mt;
    HubCallerDouble internal hub;
    HubCallerDouble internal lm;
    DepositManagerDouble internal dm;

    OpStackHubAdapter internal opAdapter;
    ArbitrumHubAdapter internal arbAdapter;
    OpStackSpoke internal opSpoke;
    ArbitrumSpoke internal arbSpoke;

    BridgeParams internal noBp;
    BridgeParams internal arbBp =
        BridgeParams({maxSubmissionCost: 0.001 ether, gasLimit: 300_000, maxFeePerGas: 1 gwei, refundAddress: address(0xF00D)});
    uint256 internal arbValue = 0.001 ether + 300_000 * 1 gwei;

    function setUp() public {
        vm.etch(ARB_SYS, type(MockArbSys).runtimeCode);
        vm.roll(1000);
        vm.deal(address(this), 100 ether);
        factory = new Create3Factory();
        usdc = new MockUSDC();
        l1m = new MockCrossDomainMessenger(relayer);
        l2m = new MockCrossDomainMessenger(relayer);
        inbox = new MockInbox();
        outbox = new MockOutbox(relayer);
        bridge = outbox.bridge();
        tm = new MockTokenMessengerV2(address(usdc), 6);
        mt = new MockMessageTransmitterV2(address(usdc), 3, attesterW.addr);
        usdc.setMinter(address(tm), true);
        usdc.setMinter(address(mt), true);
        hub = new HubCallerDouble();
        lm = new HubCallerDouble();
        dm = new DepositManagerDouble();

        address pOpAdapter = factory.predict(address(this), "OpStackHubAdapter");
        address pArbAdapter = factory.predict(address(this), "ArbitrumHubAdapter");
        address pOpSpoke = factory.predict(address(this), "OpStackSpoke");
        address pArbSpoke = factory.predict(address(this), "ArbitrumSpoke");

        opAdapter = OpStackHubAdapter(
            factory.deploy(
                "OpStackHubAdapter",
                abi.encodePacked(
                    type(OpStackHubAdapter).creationCode,
                    abi.encode(
                        OpStackHubAdapterConfig({
                            l1Messenger: address(l1m),
                            spoke: pOpSpoke,
                            spokeChainId: BASE,
                            hub: address(hub),
                            liquidityManager: address(lm),
                            depositManager: address(dm),
                            minGasL2: 300_000
                        })
                    )
                )
            )
        );
        arbAdapter = ArbitrumHubAdapter(
            factory.deploy(
                "ArbitrumHubAdapter",
                abi.encodePacked(
                    type(ArbitrumHubAdapter).creationCode,
                    abi.encode(
                        ArbitrumHubAdapterConfig({
                            inbox: address(inbox),
                            bridge: address(bridge),
                            spoke: pArbSpoke,
                            spokeChainId: ARB,
                            hub: address(hub),
                            liquidityManager: address(lm),
                            depositManager: address(dm),
                            minGasL2: 300_000
                        })
                    )
                )
            )
        );
        opSpoke = OpStackSpoke(
            factory.deploy(
                "OpStackSpoke",
                abi.encodePacked(type(OpStackSpoke).creationCode, abi.encode(_spokeCfg(pOpAdapter), address(l2m)))
            )
        );
        arbSpoke = ArbitrumSpoke(
            factory.deploy(
                "ArbitrumSpoke", abi.encodePacked(type(ArbitrumSpoke).creationCode, abi.encode(_spokeCfg(pArbAdapter)))
            )
        );
        assertEq(address(opAdapter), pOpAdapter);
        assertEq(address(opSpoke), pOpSpoke);
        assertEq(address(arbSpoke), pArbSpoke);
        dm.setAdapter(BASE, address(opAdapter));
        dm.setAdapter(ARB, address(arbAdapter));

        usdc.mint(user, 1e12);
        vm.startPrank(user);
        usdc.approve(address(opSpoke), type(uint256).max);
        usdc.approve(address(arbSpoke), type(uint256).max);
        vm.stopPrank();
    }

    function _spokeCfg(address adapter) internal view returns (SpokeConfig memory) {
        return SpokeConfig({
            usdc: address(usdc),
            hubChainId: 31337,
            hubAdapter: adapter,
            tokenMessengerV2: address(tm),
            minDeposit: 1e6,
            maxDeposit: 1e9,
            tvlCap: 1e12,
            settleFeeInsert: 75_000,
            settleFeeFinal: 25_000,
            maxCheckpoint: 64,
            minEmptyCheckpointInterval: 5,
            minGasL1: 200_000
        });
    }

    function _releaseMsg(uint64 index, address to, uint256 amount) internal view returns (bytes memory) {
        return abi.encode(
            MSG_RELEASE,
            abi.encode(
                Release({dstChainId: uint64(block.chainid), index: index, recipient: to, amount: amount, spendId: 0})
            )
        );
    }

    // ================================================================= mock-bridge relaying
    struct OpMsg {
        address target;
        address sender;
        bytes message;
        uint256 nonce;
        uint256 gasLimit;
    }

    function _opSent(MockCrossDomainMessenger m) internal returns (OpMsg memory o) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(m) && logs[i].topics[0] == IMockCrossDomainMessenger.SentMessage.selector) {
                o.target = address(uint160(uint256(logs[i].topics[1])));
                (o.sender, o.message, o.nonce, o.gasLimit) =
                    abi.decode(logs[i].data, (address, bytes, uint256, uint256));
                return o;
            }
        }
        revert("no SentMessage");
    }

    function _relayOp(MockCrossDomainMessenger dst, OpMsg memory o) internal returns (bool) {
        vm.prank(relayer);
        dst.relayMessage(o.nonce, o.sender, o.target, o.message, o.gasLimit);
        return dst.successfulMessages(dst.hashMessage(o.nonce, o.sender, o.target, o.message));
    }

    function _deliverRetryable() internal returns (bool ok, bytes memory ret) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(inbox) && logs[i].topics[0] == IMockInbox.RetryableCreated.selector) {
                (address from, address to,, uint256 gasLimit, bytes memory data) =
                    abi.decode(logs[i].data, (address, address, uint256, uint256, bytes));
                vm.prank(AddressAliasHelper.applyL1ToL2Alias(from));
                (ok, ret) = to.call{gas: gasLimit}(data);
                return (ok, ret);
            }
        }
        revert("no RetryableCreated");
    }

    struct ArbOut {
        address caller;
        address destination;
        uint256 position;
        bytes data;
    }

    function _arbSent() internal returns (ArbOut memory a) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == ARB_SYS && logs[i].topics[0] == IMockArbSys.L2ToL1Tx.selector) {
                a.destination = address(uint160(uint256(logs[i].topics[1])));
                a.position = uint256(logs[i].topics[2]);
                (a.caller, a.data) = abi.decode(logs[i].data, (address, bytes));
                return a;
            }
        }
        revert("no L2ToL1Tx");
    }

    // ================================================================= OP round trips
    function test_op_release_down() public {
        usdc.mint(address(opSpoke), 50e6);
        vm.recordLogs();
        hub.send(address(opAdapter), _releaseMsg(0, alice, 20e6), noBp);
        OpMsg memory o = _opSent(l1m);
        assertEq(o.target, address(opSpoke));
        assertEq(o.sender, address(opAdapter));
        assertEq(o.gasLimit, 300_000);
        assertTrue(_relayOp(l2m, o));
        assertEq(usdc.balanceOf(alice), 20e6);
        // bridge-level replay of a successful message reverts; a hub resend is a no-op on the spoke
        vm.prank(relayer);
        vm.expectRevert(MockCrossDomainMessenger.AlreadyRelayed.selector);
        l2m.relayMessage(o.nonce, o.sender, o.target, o.message, o.gasLimit);
        vm.recordLogs();
        hub.send(address(opAdapter), _releaseMsg(0, alice, 20e6), noBp);
        assertTrue(_relayOp(l2m, _opSent(l1m)));
        assertEq(usdc.balanceOf(alice), 20e6);
    }

    function test_op_checkpoint_up() public {
        vm.prank(user);
        opSpoke.deposit(3e6, 11, "note");
        vm.roll(block.number + 1);
        vm.recordLogs();
        opSpoke.sendCheckpoint();
        OpMsg memory o = _opSent(l2m);
        assertEq(o.target, address(opAdapter));
        assertEq(o.sender, address(opSpoke));
        assertEq(o.gasLimit, 200_000);
        vm.expectEmit(address(opAdapter));
        emit IHubAdapter.ReceivedFromSpoke(keccak256(abi.decode(_args(o.message), (bytes))));
        vm.recordLogs();
        assertTrue(_relayOp(l1m, o));
        assertEq(dm.received(BASE), 1);
        Checkpoint memory cp = _dmCheckpoint();
        assertEq(cp.deposits.length, 1);
        assertEq(cp.deposits[0].amount, 3e6);
        assertEq(cp.deposits[0].ownerDigest, 11);
        assertEq(cp.deposits[0].fee, 100_000);
    }

    function test_op_pause_down() public {
        vm.recordLogs();
        hub.send(address(opAdapter), abi.encode(MSG_PAUSE, abi.encode(true)), noBp);
        assertTrue(_relayOp(l2m, _opSent(l1m)));
        assertTrue(opSpoke.depositsPaused());
    }

    // ================================================================= Arbitrum round trips
    function test_arb_release_down() public {
        usdc.mint(address(arbSpoke), 50e6);
        bytes memory m = _releaseMsg(0, alice, 20e6);
        vm.expectCall(
            address(inbox),
            arbValue,
            abi.encodeCall(
                IInbox.createRetryableTicket,
                (
                    address(arbSpoke),
                    0,
                    arbBp.maxSubmissionCost,
                    arbBp.refundAddress,
                    address(arbSpoke), // beneficiary = spoke: the ticket can't be cancelled
                    arbBp.gasLimit,
                    arbBp.maxFeePerGas,
                    abi.encodeCall(ISpoke.receiveFromHub, (m))
                )
            )
        );
        vm.recordLogs();
        hub.send{value: arbValue}(address(arbAdapter), m, arbBp);
        (bool ok,) = _deliverRetryable();
        assertTrue(ok);
        assertEq(usdc.balanceOf(alice), 20e6);
    }

    function test_arb_checkpoint_up() public {
        vm.prank(user);
        arbSpoke.deposit(4e6, 22, "");
        vm.roll(block.number + 1);
        vm.recordLogs();
        arbSpoke.sendCheckpoint();
        ArbOut memory a = _arbSent();
        assertEq(a.caller, address(arbSpoke));
        assertEq(a.destination, address(arbAdapter));
        vm.recordLogs();
        vm.prank(relayer);
        outbox.executeTransaction(a.position, a.caller, a.destination, a.data);
        assertEq(dm.received(ARB), 1);
        assertEq(_dmCheckpoint().deposits[0].amount, 4e6);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MockOutbox.AlreadySpent.selector, a.position));
        outbox.executeTransaction(a.position, a.caller, a.destination, a.data);
    }

    // ================================================================= CCTP rebalance + queue
    function test_rebalance_cctp_mint_then_processQueue() public {
        usdc.mint(address(opSpoke), 100e6);
        // a release to Arbitrum arrives before liquidity: queued
        vm.recordLogs();
        hub.send{value: arbValue}(address(arbAdapter), _releaseMsg(0, alice, 30e6), arbBp);
        (bool ok,) = _deliverRetryable();
        assertTrue(ok);
        assertEq(uint8(arbSpoke.releaseState(0)), uint8(ISpoke.ReleaseState.Queued));

        // LiquidityManager orders Base -> Arbitrum
        RebalanceOrder memory order = RebalanceOrder({
            amount: 40e6,
            dstDomain: 3,
            mintRecipient: bytes32(uint256(uint160(address(arbSpoke)))),
            maxFee: 1e6,
            minFinality: 2000,
            nonce: 0
        });
        vm.recordLogs();
        lm.send(address(opAdapter), abi.encode(MSG_REBALANCE, abi.encode(order)), noBp);
        OpMsg memory o = _opSent(l1m);
        vm.recordLogs();
        assertTrue(_relayOp(l2m, o));
        assertEq(usdc.balanceOf(address(opSpoke)), 60e6);

        // keeper: fetch the attestation, mint on the destination
        bytes memory cctpMsg;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(tm) && logs[i].topics[0] == IMockTokenMessengerV2.MessageSent.selector) {
                cctpMsg = abi.decode(logs[i].data, (bytes));
            }
        }
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterW, keccak256(cctpMsg));
        bytes memory att = abi.encodePacked(r, s, v);
        // wrong attester is rejected
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(vm.createWallet("evil"), keccak256(cctpMsg));
        vm.expectRevert(MockMessageTransmitterV2.BadAttestation.selector);
        mt.receiveMessage(cctpMsg, abi.encodePacked(r2, s2, v2));

        assertTrue(mt.receiveMessage(cctpMsg, att));
        assertEq(usdc.balanceOf(address(arbSpoke)), 39e6);
        vm.expectRevert(abi.encodeWithSelector(MockMessageTransmitterV2.NonceUsed.selector, uint32(6), uint64(0)));
        mt.receiveMessage(cctpMsg, att);

        arbSpoke.processQueue(10);
        assertEq(usdc.balanceOf(alice), 30e6);
        assertEq(arbSpoke.queueLength(), 0);
    }

    // ================================================================= adapter negatives (sendToSpoke)
    function test_adapter_send_onlyHubOrLm() public {
        bytes memory m = _releaseMsg(0, alice, 1e6);
        vm.expectRevert(IHubAdapter.Unauthorized.selector);
        opAdapter.sendToSpoke(m, noBp);
        vm.expectRevert(IHubAdapter.Unauthorized.selector);
        arbAdapter.sendToSpoke{value: arbValue}(m, arbBp);
        vm.prank(address(dm));
        vm.expectRevert(IHubAdapter.Unauthorized.selector);
        opAdapter.sendToSpoke(m, noBp);
    }

    function test_adapter_send_kindMatrix() public {
        bytes memory rel = _releaseMsg(0, alice, 1e6);
        bytes memory reb = abi.encode(MSG_REBALANCE, abi.encode(uint256(1)));
        bytes memory cp = abi.encode(MSG_CHECKPOINT, bytes(""));
        vm.expectRevert(IHubAdapter.BadMessageKind.selector);
        hub.send(address(opAdapter), reb, noBp);
        vm.expectRevert(IHubAdapter.BadMessageKind.selector);
        hub.send(address(opAdapter), cp, noBp);
        vm.expectRevert(IHubAdapter.BadMessageKind.selector);
        lm.send(address(opAdapter), rel, noBp);
        vm.expectRevert(IHubAdapter.BadMessageKind.selector);
        lm.send{value: arbValue}(address(arbAdapter), abi.encode(MSG_PAUSE, abi.encode(true)), arbBp);
    }

    function test_adapter_op_rejectsValue() public {
        vm.expectRevert(OpStackHubAdapter.UnexpectedValue.selector);
        hub.send{value: 1}(address(opAdapter), _releaseMsg(0, alice, 1e6), noBp);
    }

    function test_adapter_arb_bridgeParams() public {
        bytes memory m = _releaseMsg(0, alice, 1e6);
        BridgeParams memory bp = arbBp;
        bp.gasLimit = 299_999;
        vm.expectRevert(ArbitrumHubAdapter.GasLimitTooLow.selector);
        hub.send{value: 1 ether}(address(arbAdapter), m, bp);
        bp = arbBp;
        bp.refundAddress = address(0);
        vm.expectRevert(ArbitrumHubAdapter.ZeroRefundAddress.selector);
        hub.send{value: 1 ether}(address(arbAdapter), m, bp);
        vm.expectRevert(IHubAdapter.InsufficientValue.selector);
        hub.send{value: arbValue - 1}(address(arbAdapter), m, arbBp);
    }

    function test_adapter_constructorChecks() public {
        OpStackHubAdapterConfig memory c = OpStackHubAdapterConfig({
            l1Messenger: address(l1m),
            spoke: address(1),
            spokeChainId: BASE,
            hub: address(0),
            liquidityManager: address(lm),
            depositManager: address(dm),
            minGasL2: 1
        });
        vm.expectRevert(AdapterLib.ZeroAddress.selector);
        new OpStackHubAdapter(c);
        c.hub = address(hub);
        c.minGasL2 = 0;
        vm.expectRevert(AdapterLib.BadConfig.selector);
        new OpStackHubAdapter(c);
    }

    // ================================================================= adapter negatives (receiveFromSpoke)
    function _cpEnvelope() internal pure returns (bytes memory) {
        Checkpoint memory cp;
        return abi.encode(MSG_CHECKPOINT, abi.encode(cp));
    }

    function test_adapter_op_receive_auth() public {
        bytes memory env = _cpEnvelope();
        // direct callers
        vm.expectRevert(IHubAdapter.NotFromSpoke.selector);
        opAdapter.receiveFromSpoke(env);
        vm.prank(address(opSpoke));
        vm.expectRevert(IHubAdapter.NotFromSpoke.selector);
        opAdapter.receiveFromSpoke(env);
        // wrong messenger (a rogue messenger with the right xDomainMessageSender)
        MockCrossDomainMessenger rogue = new MockCrossDomainMessenger(address(this));
        bytes memory data = abi.encodeCall(IHubAdapter.receiveFromSpoke, (env));
        rogue.relayMessage(0, address(opSpoke), address(opAdapter), data, 500_000);
        assertTrue(rogue.failedMessages(rogue.hashMessage(0, address(opSpoke), address(opAdapter), data)));
        // canonical messenger, wrong cross-domain sender
        OpMsg memory o = OpMsg(address(opAdapter), address(arbSpoke), data, 0, 500_000);
        assertFalse(_relayOp(l1m, o));
        o.sender = user;
        assertFalse(_relayOp(l1m, o));
        // canonical path, wrong kind
        o.sender = address(opSpoke);
        o.message = abi.encodeCall(IHubAdapter.receiveFromSpoke, (_releaseMsg(0, alice, 1)));
        assertFalse(_relayOp(l1m, o));
        assertEq(dm.received(BASE), 0);
        // canonical path, right kind
        o.message = data;
        assertTrue(_relayOp(l1m, o));
        assertEq(dm.received(BASE), 1);
    }

    function test_adapter_arb_receive_auth() public {
        bytes memory env = _cpEnvelope();
        bytes memory data = abi.encodeCall(IHubAdapter.receiveFromSpoke, (env));
        vm.expectRevert(IHubAdapter.NotFromSpoke.selector);
        arbAdapter.receiveFromSpoke(env);
        // the bridge outside an outbox execution (l2ToL1Sender == 0)
        vm.prank(address(bridge));
        vm.expectRevert(IHubAdapter.NotFromSpoke.selector);
        arbAdapter.receiveFromSpoke(env);
        // canonical outbox, wrong L2 sender
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockOutbox.CallFailed.selector, abi.encodeWithSelector(IHubAdapter.NotFromSpoke.selector)
            )
        );
        outbox.executeTransaction(0, address(opSpoke), address(arbAdapter), data);
        // rogue outbox + bridge pair with the right L2 sender
        MockOutbox rogue = new MockOutbox(address(this));
        vm.expectRevert(
            abi.encodeWithSelector(
                MockOutbox.CallFailed.selector, abi.encodeWithSelector(IHubAdapter.NotFromSpoke.selector)
            )
        );
        rogue.executeTransaction(0, address(arbSpoke), address(arbAdapter), data);
        // wrong kind on the canonical path
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockOutbox.CallFailed.selector, abi.encodeWithSelector(IHubAdapter.BadMessageKind.selector)
            )
        );
        outbox.executeTransaction(
            0, address(arbSpoke), address(arbAdapter), abi.encodeCall(IHubAdapter.receiveFromSpoke, (_releaseMsg(0, alice, 1)))
        );
        // finally the canonical one
        vm.prank(relayer);
        outbox.executeTransaction(0, address(arbSpoke), address(arbAdapter), data);
        assertEq(dm.received(ARB), 1);
    }

    // ================================================================= factory
    function test_factory_namespacesByDeployer() public {
        address other = makeAddr("other");
        assertTrue(factory.predict(other, "OpStackSpoke") != address(opSpoke));
        vm.prank(other);
        address d = factory.deploy("OpStackSpoke", type(MockArbSys).creationCode);
        assertEq(d, factory.predict(other, "OpStackSpoke"));
        vm.expectRevert(); // same deployer + salt twice
        factory.deploy("OpStackSpoke", type(MockArbSys).creationCode);
    }

    function _dmCheckpoint() internal returns (Checkpoint memory) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(dm) && logs[i].topics[0] == DepositManagerDouble.CheckpointPayload.selector) {
                return abi.decode(abi.decode(logs[i].data, (bytes)), (Checkpoint));
            }
        }
        revert("no checkpoint");
    }

    function _args(bytes memory call_) internal pure returns (bytes memory a) {
        a = new bytes(call_.length - 4);
        for (uint256 i; i < a.length; ++i) {
            a[i] = call_[i + 4];
        }
    }

    receive() external payable {}
}
