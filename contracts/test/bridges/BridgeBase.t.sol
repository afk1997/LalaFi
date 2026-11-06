// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";

import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockCrossDomainMessenger} from "../../src/mocks/MockCrossDomainMessenger.sol";
import {MockArbSys} from "../../src/mocks/MockArbSys.sol";
import {MockTokenMessengerV2} from "../../src/mocks/MockTokenMessengerV2.sol";
import {MockMessageTransmitterV2} from "../../src/mocks/MockMessageTransmitterV2.sol";
import {OpStackSpoke} from "../../src/spoke/OpStackSpoke.sol";
import {ArbitrumSpoke} from "../../src/spoke/ArbitrumSpoke.sol";
import {Spoke} from "../../src/spoke/Spoke.sol";
import {ISpoke} from "../../src/interfaces/ISpoke.sol";
import {SpokeConfig} from "../../src/libraries/DeployConfig.sol";
import {AddressAliasHelper, ARB_SYS} from "../../src/interfaces/external/IArbitrum.sol";
import {
    MSG_RELEASE, MSG_REBALANCE, MSG_PAUSE, Release, RebalanceOrder
} from "../../src/libraries/Types.sol";

abstract contract BridgeBase is Test {
    uint64 internal constant HUB_CHAIN = 31337;
    uint256 internal constant MIN_DEP = 1e6;
    uint256 internal constant MAX_DEP = 1e9;
    uint256 internal constant TVL_CAP = 1e12;
    uint256 internal constant FEE_INSERT = 75_000;
    uint256 internal constant FEE_FINAL = 25_000;
    uint256 internal constant FEE = FEE_INSERT + FEE_FINAL;
    uint64 internal constant MAX_CP = 4;
    uint64 internal constant EMPTY_INTERVAL = 10;

    address internal relayer = makeAddr("relayer");
    Vm.Wallet internal attesterW = vm.createWallet("attester");
    address internal user = makeAddr("user");
    address internal opAdapter = makeAddr("opHubAdapter");
    address internal arbAdapter = makeAddr("arbHubAdapter");

    MockUSDC internal usdc;
    MockCrossDomainMessenger internal l2m;
    MockTokenMessengerV2 internal tm;
    MockMessageTransmitterV2 internal mt;
    OpStackSpoke internal opSpoke;
    ArbitrumSpoke internal arbSpoke;
    uint256 internal relayNonce;

    function setUp() public virtual {
        vm.etch(ARB_SYS, type(MockArbSys).runtimeCode);
        vm.roll(100);
        usdc = new MockUSDC();
        l2m = new MockCrossDomainMessenger(relayer);
        tm = new MockTokenMessengerV2(address(usdc), 6);
        mt = new MockMessageTransmitterV2(address(usdc), 6, attesterW.addr);
        usdc.setMinter(address(tm), true);
        usdc.setMinter(address(mt), true);
        opSpoke = new OpStackSpoke(_cfg(opAdapter, address(tm)), address(l2m));
        arbSpoke = new ArbitrumSpoke(_cfg(arbAdapter, address(tm)));
        usdc.mint(user, 1e15);
        vm.startPrank(user);
        usdc.approve(address(opSpoke), type(uint256).max);
        usdc.approve(address(arbSpoke), type(uint256).max);
        vm.stopPrank();
    }

    function _cfgPure(address adapter, address messenger) internal pure returns (SpokeConfig memory c) {
        c = SpokeConfig({
            usdc: address(0),
            hubChainId: HUB_CHAIN,
            hubAdapter: adapter,
            tokenMessengerV2: messenger,
            minDeposit: MIN_DEP,
            maxDeposit: MAX_DEP,
            tvlCap: TVL_CAP,
            settleFeeInsert: FEE_INSERT,
            settleFeeFinal: FEE_FINAL,
            maxCheckpoint: MAX_CP,
            minEmptyCheckpointInterval: EMPTY_INTERVAL,
            minGasL1: 200_000
        });
    }

    function _cfg(address adapter, address messenger) internal view returns (SpokeConfig memory c) {
        c = _cfgPure(adapter, messenger);
        c.usdc = address(usdc);
    }

    // ------------------------------------------------------------------ message builders
    function _release(uint64 index, address to, uint256 amount) internal view returns (bytes memory) {
        return abi.encode(
            MSG_RELEASE,
            abi.encode(
                Release({
                    dstChainId: uint64(block.chainid),
                    index: index,
                    recipient: to,
                    amount: amount,
                    spendId: keccak256(abi.encode(index))
                })
            )
        );
    }

    function _rebalance(uint64 nonce, uint256 amount) internal pure returns (bytes memory) {
        return abi.encode(
            MSG_REBALANCE,
            abi.encode(
                RebalanceOrder({
                    amount: amount,
                    dstDomain: 3,
                    mintRecipient: bytes32(uint256(uint160(address(0xBEEF)))),
                    maxFee: 0,
                    minFinality: 2000,
                    nonce: nonce
                })
            )
        );
    }

    function _pause(bool p) internal pure returns (bytes memory) {
        return abi.encode(MSG_PAUSE, abi.encode(p));
    }

    // ------------------------------------------------------------------ delivery helpers
    /// @dev OP: through the mock L2 messenger as the relayer, with xDomainMessageSender = sender.
    function _deliverOp(address sender, bytes memory message) internal returns (bool ok) {
        bytes memory data = abi.encodeCall(ISpoke.receiveFromHub, (message));
        bytes32 h = l2m.hashMessage(relayNonce, sender, address(opSpoke), data);
        vm.prank(relayer);
        l2m.relayMessage(relayNonce++, sender, address(opSpoke), data, 1_000_000);
        ok = l2m.successfulMessages(h);
    }

    function _deliverOp(bytes memory message) internal {
        assertTrue(_deliverOp(opAdapter, message), "op delivery failed");
    }

    /// @dev Arbitrum: as the aliased hub adapter (what the retryable executes as).
    function _deliverArb(bytes memory message) internal {
        vm.prank(AddressAliasHelper.applyL1ToL2Alias(arbAdapter));
        arbSpoke.receiveFromHub(message);
    }

    function _deposit(Spoke s, uint256 amount) internal returns (uint64 index) {
        index = s.depositCount();
        vm.prank(user);
        s.deposit(amount, uint256(keccak256(abi.encode(index, amount))) % 2 ** 250, hex"aabb");
    }
}
