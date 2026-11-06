// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {XpoolBase} from "./base/XpoolBase.s.sol";
import {AddressAliasHelper} from "../src/interfaces/external/IArbitrum.sol";

/// @notice PRD 14.5 step 4: the on-chain checks for the chain behind --rpc-url (run it once per chain,
///         read-only, no key needed). Fails (reverts) if any check fails; prints every result.
///         Checks: code at every predicted address and deployments/<env>.json matches the predictions;
///         every immutable via its view getter; pool token symbol/decimals (config token.*, default USDC / 6);
///         messenger / inbox / bridge / outbox / ArbSys / CCTP respond (and CCTP domains); guardian == config;
///         no owner(), no EIP-1967 slots; Poseidon known-answer; code hashes of the contracts without immutables.
///         Optional parts: with no Arbitrum spoke in the config the Arbitrum checks are replaced by "hub reports
///         Arbitrum unsupported"; with zero CCTP addresses the CCTP checks are replaced by "CCTP disabled".
///         Off-chain items of 14.5 step 4 (verifier key hash vs zkey, explorer verification) are not here.
///
///   XPOOL_ENV=testnet forge script script/VerifyDeployment.s.sol --rpc-url $SEPOLIA_RPC
///   XPOOL_ENV=testnet forge script script/VerifyDeployment.s.sol --rpc-url $BASE_SEPOLIA_RPC
///   XPOOL_ENV=testnet forge script script/VerifyDeployment.s.sol --rpc-url $ARB_SEPOLIA_RPC
///   (XPOOL_CONFIG=testnet-dai for the DAI pool: Sepolia + Base Sepolia only)
contract VerifyDeployment is XpoolBase {
    bytes32 internal constant EIP1967_IMPL = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant EIP1967_ADMIN = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 internal constant EIP1967_BEACON = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    /// circomlib Poseidon(1,2) and Poseidon(1,2,3)
    uint256 internal constant POSEIDON_1_2 = 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a;
    uint256 internal constant POSEIDON_1_2_3 = 0x0e7732d89e6939c0ff03d5e58dab6302f3230e269dc5b968f725df34ab36d732;

    uint256 internal passed;
    uint256 internal failed;
    string internal dep;
    External internal x;
    bool internal haveExternal;

    function run() external {
        _load();
        dep = vm.readFile(_deploymentsPath());
        address deployer = vm.parseJsonAddress(dep, ".deployer");
        Addrs memory a = _predictAll(deployer);
        _check(vm.parseJsonAddress(dep, ".create3Factory") == a.factory, "json create3Factory == predicted");
        _check(a.factory.code.length != 0, "Create3Factory has code");
        _check(a.factory.codehash == keccak256(_deployedCode("Create3Factory.sol:Create3Factory")), "Create3Factory code hash");
        _loadExternal();

        if (block.chainid == hubChainId) _verifyHub(a, deployer);
        else if (block.chainid == baseChainId) _verifySpoke(a, true);
        else if (hasArb && block.chainid == arbChainId) _verifySpoke(a, false);
        else revert("chain is not part of this environment");

        console.log("passed", passed, "failed", failed);
        require(failed == 0, "VERIFY FAILED");
    }

    // ================================================================== external addresses
    function _loadExternal() internal {
        if (!_isLocal()) {
            x = _externalFromConfig();
            haveExternal = true;
            return;
        }
        string memory m = string.concat(".mocks.", vm.toString(block.chainid));
        if (block.chainid == hubChainId) {
            x.hubUsdc = vm.parseJsonAddress(dep, string.concat(m, ".MockUSDC"));
            x.hubTokenMessenger = vm.parseJsonAddress(dep, string.concat(m, ".MockTokenMessengerV2"));
            x.hubMessageTransmitter = vm.parseJsonAddress(dep, string.concat(m, ".MockMessageTransmitterV2"));
            x.baseL1Messenger = vm.parseJsonAddress(dep, string.concat(m, ".MockL1CrossDomainMessenger"));
            x.arbInbox = vm.parseJsonAddress(dep, string.concat(m, ".MockInbox"));
            x.arbBridge = vm.parseJsonAddress(dep, string.concat(m, ".MockBridge"));
            x.arbOutbox = vm.parseJsonAddress(dep, string.concat(m, ".MockOutbox"));
        } else if (block.chainid == baseChainId) {
            x.baseUsdc = vm.parseJsonAddress(dep, string.concat(m, ".MockUSDC"));
            x.baseL2Messenger = vm.parseJsonAddress(dep, string.concat(m, ".MockL2CrossDomainMessenger"));
            x.baseTokenMessenger = vm.parseJsonAddress(dep, string.concat(m, ".MockTokenMessengerV2"));
            x.baseMessageTransmitter = vm.parseJsonAddress(dep, string.concat(m, ".MockMessageTransmitterV2"));
        } else {
            x.arbUsdc = vm.parseJsonAddress(dep, string.concat(m, ".MockUSDC"));
            x.arbTokenMessenger = vm.parseJsonAddress(dep, string.concat(m, ".MockTokenMessengerV2"));
            x.arbMessageTransmitter = vm.parseJsonAddress(dep, string.concat(m, ".MockMessageTransmitterV2"));
        }
        haveExternal = true;
    }

    // ================================================================== hub
    function _verifyHub(Addrs memory a, address deployer) internal {
        string[9] memory names =
            [N_HUB, N_DEPOSIT, N_STAKE, N_LIQUIDITY, N_VERIFIER, N_POSEIDON_T3, N_POSEIDON_T4, N_OP_ADAPTER, N_ARB_ADAPTER];
        address[9] memory addrs = [
            a.hubCore,
            a.depositManager,
            a.stakeManager,
            a.liquidityManager,
            a.verifier,
            a.poseidonT3,
            a.poseidonT4,
            a.opAdapter,
            a.arbAdapter
        ];
        uint256 nContracts = hasArb ? names.length : names.length - 1; // ArbitrumHubAdapter is last
        if (!hasArb) {
            _check(
                !vm.keyExistsJson(dep, string.concat(".hub.contracts.", N_ARB_ADAPTER)), "json has no ArbitrumHubAdapter"
            );
            _check(
                _predict(deployer, N_ARB_ADAPTER).code.length == 0, "no ArbitrumHubAdapter at its CREATE3 address"
            );
        }
        for (uint256 i; i < nContracts; ++i) {
            _check(addrs[i].code.length != 0, string.concat(names[i], " has code"));
            _check(
                vm.parseJsonAddress(dep, string.concat(".hub.contracts.", names[i])) == addrs[i],
                string.concat("json ", names[i], " == predicted")
            );
            _noOwnerNoProxy(names[i], addrs[i]);
        }
        _check(vm.parseJsonUint(dep, ".hub.chainId") == hubChainId, "json hub.chainId");
        _check(vm.parseJsonAddress(dep, ".hub.usdc") == x.hubUsdc, "json hub.usdc");

        // code hashes of immutable-free contracts
        _check(a.verifier.codehash == keccak256(_deployedCode("Groth16Verifier.sol:Groth16Verifier")), "verifier code hash");
        _check(_libCodeMatches(a.poseidonT3, "PoseidonT3.sol:PoseidonT3"), "PoseidonT3 code hash");
        _check(_libCodeMatches(a.poseidonT4, "PoseidonT4.sol:PoseidonT4"), "PoseidonT4 code hash");
        uint256[2] memory in2 = [uint256(1), 2];
        uint256[3] memory in3 = [uint256(1), 2, 3];
        _eqU(a.poseidonT3, abi.encodeWithSignature("hash(uint256[2])", in2), POSEIDON_1_2, "PoseidonT3(1,2)");
        _eqU(a.poseidonT4, abi.encodeWithSignature("hash(uint256[3])", in3), POSEIDON_1_2_3, "PoseidonT4(1,2,3)");

        // HubCore
        _eqAs(a.hubCore, "guardian()", _guardian(deployer), "HubCore.guardian == config");
        _eqA(a.hubCore, abi.encodeWithSignature("adapterFor(uint64)", baseChainId), a.opAdapter, "HubCore.adapterFor(base)");
        _eqU(a.hubCore, abi.encodeWithSignature("isSupportedChain(uint64)", baseChainId), 1, "HubCore supports base");
        if (hasArb) {
            _eqA(
                a.hubCore, abi.encodeWithSignature("adapterFor(uint64)", arbChainId), a.arbAdapter, "HubCore.adapterFor(arb)"
            );
            _eqU(a.hubCore, abi.encodeWithSignature("isSupportedChain(uint64)", arbChainId), 1, "HubCore supports arb");
        } else {
            _verifyArbDisabled(a);
        }
        _eqU(a.hubCore, abi.encodeWithSignature("phiBps()"), _u(".params.phiBps"), "HubCore.phiBps");
        _eqU(a.hubCore, abi.encodeWithSignature("relayerFeeBucket()"), _u(".params.relayerFeeBucket"), "HubCore.relayerFeeBucket");
        _eqU(
            a.hubCore,
            abi.encodeWithSignature("minWithdraw(uint64)", baseChainId),
            _u(".params.minWithdraw"),
            "HubCore.minWithdraw(base)"
        );
        // DepositManager
        _eqA(a.depositManager, abi.encodeWithSignature("spokeOf(uint64)", baseChainId), a.baseSpoke, "DM.spokeOf(base)");
        if (hasArb) {
            _eqA(a.depositManager, abi.encodeWithSignature("spokeOf(uint64)", arbChainId), a.arbSpoke, "DM.spokeOf(arb)");
        }
        _eqU(a.depositManager, abi.encodeWithSignature("minDeposit()"), _u(".params.minDeposit"), "DM.minDeposit");
        _eqU(a.depositManager, abi.encodeWithSignature("maxDeposit()"), _u(".params.maxDeposit"), "DM.maxDeposit");
        _eqU(a.depositManager, abi.encodeWithSignature("maxFastDeposit()"), _u(".params.maxFastDeposit"), "DM.maxFastDeposit");
        // StakeManager
        _eqU(a.stakeManager, abi.encodeWithSignature("sMin()"), _u(".params.sMin"), "SM.sMin");
        _eqBytes(a.stakeManager, "k()", abi.encode(_uAt(".params.k", 0), _uAt(".params.k", 1)), "SM.k");
        _eqBytes(a.stakeManager, "theta()", abi.encode(_uAt(".params.theta", 0), _uAt(".params.theta", 1)), "SM.theta");
        // LiquidityManager
        _eqU(
            a.liquidityManager,
            abi.encodeWithSignature("targetBps(uint64)", hubChainId),
            _perChain(".params.targetBps", hubChainId),
            "LM.targetBps(eth)"
        );
        _eqU(
            a.liquidityManager,
            abi.encodeWithSignature("targetBps(uint64)", baseChainId),
            _perChain(".params.targetBps", baseChainId),
            "LM.targetBps(base)"
        );
        if (hasArb) {
            _eqU(
                a.liquidityManager,
                abi.encodeWithSignature("targetBps(uint64)", arbChainId),
                _perChain(".params.targetBps", arbChainId),
                "LM.targetBps(arb)"
            );
        }
        _eqAs(a.liquidityManager, "tokenMessenger()", x.hubTokenMessenger, "LM.tokenMessenger");
        _eqU(a.liquidityManager, abi.encodeWithSignature("decimals()"), _tokenDecimals(), "LM.decimals == token");
        // adapters
        _adapterCommon(a.opAdapter, "OpStackHubAdapter", a.baseSpoke, baseChainId, a);
        _eqAs(a.opAdapter, "l1Messenger()", x.baseL1Messenger, "OpStackHubAdapter.l1Messenger");
        _eqU(a.opAdapter, abi.encodeWithSignature("minGasL2()"), _u(".params.minGasL2"), "OpStackHubAdapter.minGasL2");
        if (hasArb) {
            _adapterCommon(a.arbAdapter, "ArbitrumHubAdapter", a.arbSpoke, arbChainId, a);
            _eqAs(a.arbAdapter, "inbox()", x.arbInbox, "ArbitrumHubAdapter.inbox");
            _eqAs(a.arbAdapter, "bridge()", x.arbBridge, "ArbitrumHubAdapter.bridge");
            _eqU(
                a.arbAdapter, abi.encodeWithSignature("minGasL2()"), _u(".params.minGasL2"), "ArbitrumHubAdapter.minGasL2"
            );
        }
        // the spokes' addresses must have NO code on L1 (they are retryable beneficiaries; see ArbitrumHubAdapter)
        _check(a.baseSpoke.code.length == 0 && a.arbSpoke.code.length == 0, "spoke addresses empty on L1");

        // external surfaces
        _token(x.hubUsdc, "hub token");
        _responds(x.baseL1Messenger, abi.encodeWithSignature("messageNonce()"), "L1CrossDomainMessenger responds");
        if (!_isLocal()) {
            _check(_addr(_sp(baseIdx, ".l1.optimismPortal")).code.length != 0, "OptimismPortal has code");
        }
        if (hasArb) {
            _responds(
                x.arbInbox,
                abi.encodeWithSignature("calculateRetryableSubmissionFee(uint256,uint256)", 0, 1),
                "Inbox responds"
            );
            _check(_bridgeKnowsOutbox(), "Bridge accepts Outbox");
            _responds(x.arbOutbox, abi.encodeWithSignature("l2ToL1Sender()"), "Outbox responds");
            _eqAs(x.arbOutbox, "bridge()", x.arbBridge, "Outbox.bridge == Bridge");
        }
        _cctp(x.hubTokenMessenger, x.hubMessageTransmitter, uint32(_u(".hub.cctp.domain")), "hub");
    }

    /// @dev No Arbitrum spoke in the config: every hub contract must have Arbitrum disabled.
    function _verifyArbDisabled(Addrs memory a) internal {
        uint64 arbId = _knownArbChainId();
        _eqU(a.hubCore, abi.encodeWithSignature("arbChainId()"), 0, "HubCore.arbChainId == 0 (Arbitrum disabled)");
        _eqAs(a.hubCore, "arbAdapter()", address(0), "HubCore.arbAdapter == 0");
        _eqU(a.depositManager, abi.encodeWithSignature("arbChainId()"), 0, "DM.arbChainId == 0");
        _eqAs(a.depositManager, "arbSpoke()", address(0), "DM.arbSpoke == 0");
        _eqU(a.stakeManager, abi.encodeWithSignature("arbChainId()"), 0, "SM.arbChainId == 0");
        _eqU(a.liquidityManager, abi.encodeWithSignature("arbChainId()"), 0, "LM.arbChainId == 0");
        _eqAs(a.liquidityManager, "arbSpoke()", address(0), "LM.arbSpoke == 0");
        _eqU(a.hubCore, abi.encodeWithSignature("isSupportedChain(uint64)", uint64(0)), 0, "HubCore: chain 0 unsupported");
        _eqU(
            a.hubCore,
            abi.encodeWithSignature("isSupportedChain(uint64)", arbId),
            0,
            string.concat("HubCore: Arbitrum (", vm.toString(uint256(arbId)), ") unsupported")
        );
        _check(
            _reverts(a.hubCore, abi.encodeWithSignature("adapterFor(uint64)", arbId)), "HubCore.adapterFor(arb) reverts"
        );
        _eqA(a.depositManager, abi.encodeWithSignature("spokeOf(uint64)", arbId), address(0), "DM.spokeOf(arb) == 0");
    }

    /// @dev The Arbitrum chain id of this environment kind (for the "unsupported" check).
    function _knownArbChainId() internal view returns (uint64) {
        if (_eq(env, "mainnet")) return 42161;
        if (_eq(env, "testnet")) return 421614;
        return 31339;
    }

    function _adapterCommon(address ad, string memory n, address spoke, uint64 chainId, Addrs memory a) internal {
        _eqAs(ad, "spoke()", spoke, string.concat(n, ".spoke"));
        _eqU(ad, abi.encodeWithSignature("spokeChainId()"), chainId, string.concat(n, ".spokeChainId"));
        _eqAs(ad, "hub()", a.hubCore, string.concat(n, ".hub"));
        _eqAs(ad, "liquidityManager()", a.liquidityManager, string.concat(n, ".liquidityManager"));
        _eqAs(ad, "depositManager()", a.depositManager, string.concat(n, ".depositManager"));
    }

    // ================================================================== spokes
    function _verifySpoke(Addrs memory a, bool isBase) internal {
        address s = isBase ? a.baseSpoke : a.arbSpoke;
        string memory n = isBase ? "OpStackSpoke" : "ArbitrumSpoke";
        string memory j = string.concat(".spokes.", vm.toString(block.chainid));
        _check(s.code.length != 0, string.concat(n, " has code"));
        _check(vm.parseJsonAddress(dep, string.concat(j, ".contracts.Spoke")) == s, "json spoke == predicted");
        address usdc_ = isBase ? x.baseUsdc : x.arbUsdc;
        _check(vm.parseJsonAddress(dep, string.concat(j, ".usdc")) == usdc_, "json spoke usdc");
        _noOwnerNoProxy(n, s);

        _eqAs(s, "usdc()", usdc_, string.concat(n, ".usdc"));
        _eqU(s, abi.encodeWithSignature("hubChainId()"), hubChainId, string.concat(n, ".hubChainId"));
        _eqAs(s, "hubAdapter()", isBase ? a.opAdapter : a.arbAdapter, string.concat(n, ".hubAdapter"));
        _eqAs(
            s,
            "tokenMessengerV2()",
            isBase ? x.baseTokenMessenger : x.arbTokenMessenger,
            string.concat(n, ".tokenMessengerV2")
        );
        _eqU(s, abi.encodeWithSignature("minDeposit()"), _u(".params.minDeposit"), string.concat(n, ".minDeposit"));
        _eqU(s, abi.encodeWithSignature("maxDeposit()"), _u(".params.maxDeposit"), string.concat(n, ".maxDeposit"));
        _eqU(
            s,
            abi.encodeWithSignature("tvlCap()"),
            _perChain(".params.tvlCap", uint64(block.chainid)),
            string.concat(n, ".tvlCap")
        );
        _eqU(s, abi.encodeWithSignature("settleFeeInsert()"), _u(".params.settleFee.insert"), "settleFeeInsert");
        _eqU(s, abi.encodeWithSignature("settleFeeFinal()"), _u(".params.settleFee.final"), "settleFeeFinal");
        _eqU(s, abi.encodeWithSignature("maxCheckpoint()"), _u(".params.maxCheckpoint"), "maxCheckpoint");
        _eqU(
            s,
            abi.encodeWithSignature("minEmptyCheckpointInterval()"),
            _u(".params.minEmptyCheckpointInterval"),
            "minEmptyCheckpointInterval"
        );
        _eqU(s, abi.encodeWithSignature("minGasL1()"), _u(".params.minGasL1"), "minGasL1");
        _token(usdc_, "spoke token");
        if (isBase) {
            _eqAs(s, "l2Messenger()", x.baseL2Messenger, "OpStackSpoke.l2Messenger");
            _responds(x.baseL2Messenger, abi.encodeWithSignature("messageNonce()"), "L2CrossDomainMessenger responds");
            _cctp(x.baseTokenMessenger, x.baseMessageTransmitter, uint32(_u(_sp(baseIdx, ".cctp.domain"))), "base");
        } else {
            _eqAs(
                s, "aliasedHubAdapter()", AddressAliasHelper.applyL1ToL2Alias(a.arbAdapter), "ArbitrumSpoke.aliasedHubAdapter"
            );
            _responds(address(100), abi.encodeWithSignature("arbBlockNumber()"), "ArbSys responds");
            _cctp(x.arbTokenMessenger, x.arbMessageTransmitter, uint32(_u(_sp(arbIdx, ".cctp.domain"))), "arbitrum");
        }
    }

    // ================================================================== helpers
    function _check(bool ok, string memory what) internal {
        if (ok) {
            ++passed;
            console.log("  ok  ", what);
        } else {
            ++failed;
            console.log("  FAIL", what);
        }
    }

    function _call(address t, bytes memory data) internal view returns (bool ok, bytes memory ret) {
        if (t.code.length == 0 && t != address(100)) return (false, "");
        (ok, ret) = t.staticcall(data);
    }

    function _eqU(address t, bytes memory data, uint256 want, string memory what) internal {
        (bool ok, bytes memory ret) = _call(t, data);
        _check(ok && ret.length >= 32 && abi.decode(ret, (uint256)) == want, what);
    }

    function _eqAs(address t, string memory sig, address want, string memory what) internal {
        _eqA(t, abi.encodeWithSignature(sig), want, what);
    }

    function _eqA(address t, bytes memory data, address want, string memory what) internal {
        (bool ok, bytes memory ret) = _call(t, data);
        _check(ok && ret.length == 32 && abi.decode(ret, (address)) == want, what);
    }

    function _eqBytes(address t, string memory sig, bytes memory want, string memory what) internal {
        (bool ok, bytes memory ret) = _call(t, abi.encodeWithSignature(sig));
        _check(ok && keccak256(ret) == keccak256(want), what);
    }

    /// @dev True if `t` has code and the call reverts.
    function _reverts(address t, bytes memory data) internal view returns (bool) {
        if (t.code.length == 0) return false;
        (bool ok,) = t.staticcall(data);
        return !ok;
    }

    function _responds(address t, bytes memory data, string memory what) internal {
        (bool ok,) = _call(t, data);
        _check(ok, what);
    }

    /// @dev Pool token symbol / decimals: config token.symbol / token.decimals (default USDC / 6).
    function _token(address token, string memory what) internal {
        string memory sym = _tokenSymbol();
        uint8 dec = _tokenDecimals();
        (bool ok, bytes memory ret) = _call(token, abi.encodeWithSignature("symbol()"));
        _check(
            ok && ret.length >= 64 && _eq(abi.decode(ret, (string)), sym), string.concat(what, " symbol ", sym)
        );
        _eqU(token, abi.encodeWithSignature("decimals()"), dec, string.concat(what, " decimals ", vm.toString(dec)));
    }

    /// @dev Zero TokenMessengerV2 + MessageTransmitterV2 = CCTP disabled for this pool (nothing to probe).
    function _cctp(address tokenMessenger, address transmitter, uint32 domain, string memory what) internal {
        if (tokenMessenger == address(0) || transmitter == address(0)) {
            _check(
                tokenMessenger == address(0) && transmitter == address(0),
                string.concat("CCTP disabled: both addresses zero (", what, ")")
            );
            return;
        }
        _check(tokenMessenger.code.length != 0, string.concat("CCTP TokenMessengerV2 has code (", what, ")"));
        _eqU(transmitter, abi.encodeWithSignature("localDomain()"), domain, string.concat("CCTP domain (", what, ")"));
    }

    function _noOwnerNoProxy(string memory n, address t) internal {
        (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSignature("owner()"));
        _check(!ok || ret.length == 0, string.concat(n, ": no owner()"));
        _check(
            vm.load(t, EIP1967_IMPL) == 0 && vm.load(t, EIP1967_ADMIN) == 0 && vm.load(t, EIP1967_BEACON) == 0,
            string.concat(n, ": no EIP-1967 proxy slots")
        );
    }

    function _bridgeKnowsOutbox() internal view returns (bool) {
        (bool ok, bytes memory ret) = _call(x.arbBridge, abi.encodeWithSignature("allowedOutboxes(address)", x.arbOutbox));
        if (ok && ret.length == 32) return abi.decode(ret, (bool));
        (ok, ret) = _call(x.arbBridge, abi.encodeWithSignature("activeOutbox()")); // MockBridge
        return ok && ret.length == 32 && abi.decode(ret, (address)) == x.arbOutbox;
    }

    function _deployedCode(string memory artifact) internal view returns (bytes memory c) {
        try vm.getDeployedCode(artifact) returns (bytes memory code) {
            c = code;
        } catch {}
    }

    /// @dev Deployed libraries carry their own address in bytes [1, 21) (call-protection PUSH20).
    function _libCodeMatches(address lib, string memory artifact) internal view returns (bool) {
        bytes memory c = _deployedCode(artifact);
        if (c.length < 21) return false;
        bytes20 self = bytes20(lib);
        for (uint256 i; i < 20; ++i) {
            c[1 + i] = self[i];
        }
        return lib.codehash == keccak256(c);
    }
}
