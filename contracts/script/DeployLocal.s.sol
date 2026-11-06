// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {XpoolBase} from "./base/XpoolBase.s.sol";

import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCrossDomainMessenger} from "../src/mocks/MockCrossDomainMessenger.sol";
import {MockInbox} from "../src/mocks/MockInbox.sol";
import {MockOutbox} from "../src/mocks/MockOutbox.sol";
import {MockTokenMessengerV2} from "../src/mocks/MockTokenMessengerV2.sol";
import {MockMessageTransmitterV2} from "../src/mocks/MockMessageTransmitterV2.sol";
import {ARB_SYS} from "../src/interfaces/external/IArbitrum.sol";

/// @notice LOCAL ONLY. One entry point per Anvil chain; run by script/deploy-local.sh:
///           hub()      on 31337: hub mocks + every hub contract  (writes deployments/local.json)
///           base()     on 31338: L2 mocks + OpStackSpoke         (updates spokes.31338, mocks.31338)
///           arbitrum() on 31339: L2 mocks + ArbitrumSpoke        (updates spokes.31339, mocks.31339)
///         MockArbSys must already be at address(100) on 31339 (anvil_setCode, done by the shell helper).
///         Keys: Anvil default mnemonic; 0 = deployer, 1 = mock-bridge relayer + CCTP attester.
///         Mocks are plain CREATE deployments, so the chains must be fresh.
contract DeployLocal is XpoolBase {
    struct HubMocks {
        address usdc;
        address l1Messenger;
        address inbox;
        address bridge;
        address outbox;
        address tokenMessenger;
        address messageTransmitter;
    }

    struct L2Mocks {
        address usdc;
        address l2Messenger;
        address tokenMessenger;
        address messageTransmitter;
    }

    function _setup() internal returns (uint256 pk, address deployer, address relayer, Addrs memory a) {
        _load();
        require(_isLocal(), "DeployLocal: XPOOL_ENV must be local");
        pk = _deployerKey();
        deployer = vm.addr(pk);
        relayer = vm.addr(_anvilKey(1));
        a = _predictAll(deployer);
    }

    function _domain(string memory key) internal view returns (uint32) {
        return uint32(_u(key));
    }

    // ================================================================== 31337
    function hub() external {
        (uint256 pk, address deployer, address relayer, Addrs memory a) = _setup();
        require(block.chainid == hubChainId, "hub(): wrong chain");
        require(a.hubCore.code.length == 0, "hub already deployed: restart anvil (mocks are not deterministic)");
        uint256 deployBlock = block.number;

        vm.startBroadcast(pk);
        HubMocks memory m;
        MockUSDC usdc = new MockUSDC();
        m.usdc = address(usdc);
        m.l1Messenger = address(new MockCrossDomainMessenger(relayer));
        m.inbox = address(new MockInbox());
        MockOutbox outbox = new MockOutbox(relayer);
        m.outbox = address(outbox);
        m.bridge = address(outbox.bridge());
        m.tokenMessenger = address(new MockTokenMessengerV2(m.usdc, _domain(".hub.cctp.domain")));
        m.messageTransmitter =
            address(new MockMessageTransmitterV2(m.usdc, _domain(".hub.cctp.domain"), relayer));
        usdc.setMinter(m.tokenMessenger, true);
        usdc.setMinter(m.messageTransmitter, true);

        External memory x;
        x.hubUsdc = m.usdc;
        x.hubTokenMessenger = m.tokenMessenger;
        x.hubMessageTransmitter = m.messageTransmitter;
        x.baseL1Messenger = m.l1Messenger;
        x.arbInbox = m.inbox;
        x.arbBridge = m.bridge;
        x.arbOutbox = m.outbox;
        _deployHubContracts(deployer, a, x);
        vm.stopBroadcast();

        _writeSkeleton(deployer, a, x);
        _writeHubSection(a, deployBlock, m.usdc);
        string memory k = "mocks-hub";
        vm.serializeAddress(k, "MockUSDC", m.usdc);
        vm.serializeAddress(k, "MockL1CrossDomainMessenger", m.l1Messenger);
        vm.serializeAddress(k, "MockInbox", m.inbox);
        vm.serializeAddress(k, "MockBridge", m.bridge);
        vm.serializeAddress(k, "MockOutbox", m.outbox);
        vm.serializeAddress(k, "MockTokenMessengerV2", m.tokenMessenger);
        string memory j = vm.serializeAddress(k, "MockMessageTransmitterV2", m.messageTransmitter);
        vm.writeJson(j, _deploymentsPath(), string.concat(".mocks.", vm.toString(uint256(hubChainId))));
        _logAddrs(a);
        console.log("wrote", _deploymentsPath());
    }

    // ================================================================== 31338 / 31339
    function base() external {
        _spoke(true);
    }

    function arbitrum() external {
        _spoke(false);
    }

    function _spoke(bool isBase) internal {
        (uint256 pk, address deployer, address relayer, Addrs memory a) = _setup();
        require(block.chainid == (isBase ? baseChainId : arbChainId), "wrong chain");
        require(_deploymentsExist(), "run hub() first");
        if (!isBase) require(ARB_SYS.code.length != 0, "MockArbSys missing at address(100): anvil_setCode first");
        uint256 deployBlock = block.number; // MockArbSys.arbBlockNumber() == block.number

        vm.startBroadcast(pk);
        L2Mocks memory m = _deployL2Mocks(isBase, relayer);
        External memory x;
        if (isBase) {
            x.baseUsdc = m.usdc;
            x.baseL2Messenger = m.l2Messenger;
            x.baseTokenMessenger = m.tokenMessenger;
            x.baseMessageTransmitter = m.messageTransmitter;
        } else {
            x.arbUsdc = m.usdc;
            x.arbTokenMessenger = m.tokenMessenger;
            x.arbMessageTransmitter = m.messageTransmitter;
        }
        address s = _deploySpokeContract(deployer, isBase, a, x);
        vm.stopBroadcast();

        _writeSpokeSection(isBase, m.usdc, s, deployBlock);
        _writeL2Mocks(isBase, m);
        console.log(isBase ? "OpStackSpoke" : "ArbitrumSpoke", s);
    }

    function _deployL2Mocks(bool isBase, address relayer) internal returns (L2Mocks memory m) {
        uint32 domain = _domain(_sp(isBase ? baseIdx : arbIdx, ".cctp.domain"));
        MockUSDC usdc = new MockUSDC();
        m.usdc = address(usdc);
        if (isBase) m.l2Messenger = address(new MockCrossDomainMessenger(relayer));
        m.tokenMessenger = address(new MockTokenMessengerV2(m.usdc, domain));
        m.messageTransmitter = address(new MockMessageTransmitterV2(m.usdc, domain, relayer));
        usdc.setMinter(m.tokenMessenger, true);
        usdc.setMinter(m.messageTransmitter, true);
    }

    function _writeL2Mocks(bool isBase, L2Mocks memory m) internal {
        string memory k = isBase ? "mocks-base" : "mocks-arb";
        vm.serializeAddress(k, "MockUSDC", m.usdc);
        if (isBase) vm.serializeAddress(k, "MockL2CrossDomainMessenger", m.l2Messenger);
        else vm.serializeAddress(k, "MockArbSys", ARB_SYS);
        vm.serializeAddress(k, "MockTokenMessengerV2", m.tokenMessenger);
        string memory j = vm.serializeAddress(k, "MockMessageTransmitterV2", m.messageTransmitter);
        uint256 chainId = isBase ? baseChainId : arbChainId;
        vm.writeJson(j, _deploymentsPath(), string.concat(".mocks.", vm.toString(chainId)));
    }
}
