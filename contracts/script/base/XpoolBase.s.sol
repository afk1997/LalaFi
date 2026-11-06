// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CREATE3} from "solady/utils/CREATE3.sol";

// Imported only so the artifacts exist for vm.getCode (scripts never link them).
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";

import {Create3Factory} from "../../src/utils/Create3Factory.sol";
import {
    HubCoreConfig,
    DepositManagerConfig,
    StakeManagerConfig,
    LiquidityManagerConfig,
    SpokeConfig,
    OpStackHubAdapterConfig,
    ArbitrumHubAdapterConfig
} from "../../src/libraries/DeployConfig.sol";

/// @title Shared plumbing for every xpool deploy script.
/// @notice - env:     XPOOL_ENV = local | testnet | mainnet (default local); reads config/<env>.json
///         - key:     DEPLOYER_PRIVATE_KEY (local default: Anvil mnemonic account 0)
///         - salts:   keccak256("<config.salt>/<ContractName>"), namespaced by the deployer inside
///                    Create3Factory, so addresses = f(factory, deployer, salt) on every chain.
///         - factory: Create3Factory deployed by CREATE2 through 0x4e59b44847b379578588920cA78FbF26c0B4956C
///                    with FACTORY_SALT, so it has the same address on every chain.
abstract contract XpoolBase is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant FACTORY_SALT = keccak256("xpool.create3factory.v1");
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

    // CREATE3 names (also the keys of deployments/<env>.json -> hub.contracts)
    string internal constant N_POSEIDON_T3 = "PoseidonT3";
    string internal constant N_POSEIDON_T4 = "PoseidonT4";
    string internal constant N_VERIFIER = "Groth16Verifier";
    string internal constant N_STAKE = "StakeManager";
    string internal constant N_LIQUIDITY = "LiquidityManager";
    string internal constant N_DEPOSIT = "DepositManager";
    string internal constant N_HUB = "HubCore";
    string internal constant N_OP_ADAPTER = "OpStackHubAdapter";
    string internal constant N_ARB_ADAPTER = "ArbitrumHubAdapter";
    string internal constant N_BASE_SPOKE = "BaseSpoke"; // OpStackSpoke, deployed only on the OP chain
    string internal constant N_ARB_SPOKE = "ArbitrumSpoke"; // deployed only on the Arbitrum chain

    /// @dev All protocol addresses (CREATE3 predictions).
    struct Addrs {
        address factory;
        address poseidonT3;
        address poseidonT4;
        address verifier;
        address stakeManager;
        address liquidityManager;
        address depositManager;
        address hubCore;
        address opAdapter;
        address arbAdapter;
        address baseSpoke;
        address arbSpoke;
    }

    /// @dev External (non-xpool) addresses. From config for testnet/mainnet, from mocks for local.
    struct External {
        address hubUsdc;
        address hubTokenMessenger;
        address hubMessageTransmitter;
        address baseUsdc;
        address baseL1Messenger;
        address baseL2Messenger;
        address baseTokenMessenger;
        address baseMessageTransmitter;
        address arbUsdc;
        address arbInbox;
        address arbBridge;
        address arbOutbox;
        address arbTokenMessenger;
        address arbMessageTransmitter;
    }

    string internal env;
    string internal cfg;
    string internal salt;
    uint256 internal baseIdx;
    uint256 internal arbIdx;
    uint64 internal hubChainId;
    uint64 internal baseChainId;
    uint64 internal arbChainId;

    // ================================================================== loading
    function _load() internal {
        env = vm.envOr("XPOOL_ENV", string("local"));
        cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/", env, ".json"));
        salt = vm.parseJsonString(cfg, ".salt");
        hubChainId = uint64(vm.parseJsonUint(cfg, ".hub.chainId"));
        bool foundBase;
        bool foundArb;
        for (uint256 i; i < 2; ++i) {
            string memory stack = vm.parseJsonString(cfg, string.concat(".spokes[", vm.toString(i), "].stack"));
            if (keccak256(bytes(stack)) == keccak256("opstack")) {
                baseIdx = i;
                foundBase = true;
            } else if (keccak256(bytes(stack)) == keccak256("arbitrum")) {
                arbIdx = i;
                foundArb = true;
            }
        }
        require(foundBase && foundArb, "config: need one opstack and one arbitrum spoke");
        baseChainId = uint64(vm.parseJsonUint(cfg, _sp(baseIdx, ".chainId")));
        arbChainId = uint64(vm.parseJsonUint(cfg, _sp(arbIdx, ".chainId")));
    }

    function _isLocal() internal view returns (bool) {
        return keccak256(bytes(env)) == keccak256("local");
    }

    function _deployerKey() internal view returns (uint256) {
        if (_isLocal()) return vm.envOr("DEPLOYER_PRIVATE_KEY", vm.deriveKey(ANVIL_MNEMONIC, 0));
        return vm.envUint("DEPLOYER_PRIVATE_KEY");
    }

    function _anvilKey(uint32 i) internal pure returns (uint256) {
        return vm.deriveKey(ANVIL_MNEMONIC, i);
    }

    // ================================================================== config readers
    function _sp(uint256 i, string memory key) internal pure returns (string memory) {
        return string.concat(".spokes[", vm.toString(i), "]", key);
    }

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(cfg, key);
    }

    function _uAt(string memory key, uint256 i) internal view returns (uint256) {
        return vm.parseJsonUintArray(cfg, key)[i];
    }

    function _perChain(string memory key, uint64 chainId) internal view returns (uint256) {
        return vm.parseJsonUint(cfg, string.concat(key, ".", vm.toString(uint256(chainId))));
    }

    function _addr(string memory key) internal view returns (address) {
        string memory s = vm.parseJsonString(cfg, key);
        require(keccak256(bytes(s)) != keccak256("DEPLOYED_MOCK"), string.concat("config: ", key, " is a mock"));
        return vm.parseAddress(s);
    }

    function _externalFromConfig() internal view returns (External memory x) {
        x.hubUsdc = _addr(".hub.usdc");
        x.hubTokenMessenger = _addr(".hub.cctp.tokenMessengerV2");
        x.hubMessageTransmitter = _addr(".hub.cctp.messageTransmitterV2");
        x.baseUsdc = _addr(_sp(baseIdx, ".usdc"));
        x.baseL1Messenger = _addr(_sp(baseIdx, ".l1.l1CrossDomainMessenger"));
        x.baseL2Messenger = _addr(_sp(baseIdx, ".l2.l2CrossDomainMessenger"));
        x.baseTokenMessenger = _addr(_sp(baseIdx, ".cctp.tokenMessengerV2"));
        x.baseMessageTransmitter = _addr(_sp(baseIdx, ".cctp.messageTransmitterV2"));
        x.arbUsdc = _addr(_sp(arbIdx, ".usdc"));
        x.arbInbox = _addr(_sp(arbIdx, ".l1.inbox"));
        x.arbBridge = _addr(_sp(arbIdx, ".l1.bridge"));
        x.arbOutbox = _addr(_sp(arbIdx, ".l1.outbox"));
        x.arbTokenMessenger = _addr(_sp(arbIdx, ".cctp.tokenMessengerV2"));
        x.arbMessageTransmitter = _addr(_sp(arbIdx, ".cctp.messageTransmitterV2"));
    }

    /// @dev params.guardian, overridable with env GUARDIAN. Zero is only accepted locally (-> deployer).
    function _guardian(address deployer) internal view returns (address g) {
        g = vm.envOr("GUARDIAN", vm.parseJsonAddress(cfg, ".params.guardian"));
        if (g == address(0)) {
            require(_isLocal(), "config: params.guardian (or env GUARDIAN) must be the team Safe");
            g = deployer;
        }
    }

    // ================================================================== addresses
    function _factoryAddress() internal pure returns (address) {
        return vm.computeCreate2Address(FACTORY_SALT, keccak256(type(Create3Factory).creationCode), CREATE2_DEPLOYER);
    }

    function _salt(string memory name) internal view returns (bytes32) {
        return keccak256(bytes(string.concat(salt, "/", name)));
    }

    /// @dev Same math as Create3Factory.predict, computed offline (no RPC needed).
    function _predict(address deployer, string memory name) internal view returns (address) {
        return CREATE3.predictDeterministicAddress(keccak256(abi.encode(deployer, _salt(name))), _factoryAddress());
    }

    function _predictAll(address deployer) internal view returns (Addrs memory a) {
        a.factory = _factoryAddress();
        a.poseidonT3 = _predict(deployer, N_POSEIDON_T3);
        a.poseidonT4 = _predict(deployer, N_POSEIDON_T4);
        a.verifier = _predict(deployer, N_VERIFIER);
        a.stakeManager = _predict(deployer, N_STAKE);
        a.liquidityManager = _predict(deployer, N_LIQUIDITY);
        a.depositManager = _predict(deployer, N_DEPOSIT);
        a.hubCore = _predict(deployer, N_HUB);
        a.opAdapter = _predict(deployer, N_OP_ADAPTER);
        a.arbAdapter = _predict(deployer, N_ARB_ADAPTER);
        a.baseSpoke = _predict(deployer, N_BASE_SPOKE);
        a.arbSpoke = _predict(deployer, N_ARB_SPOKE);
    }

    // ================================================================== deployment primitives (inside a broadcast)
    function _ensureFactory() internal returns (address f) {
        f = _factoryAddress();
        if (f.code.length != 0) return f;
        require(CREATE2_DEPLOYER.code.length != 0, "deterministic deployer 0x4e59... missing on this chain");
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(FACTORY_SALT, type(Create3Factory).creationCode));
        require(ok && f.code.length != 0, "Create3Factory deployment failed");
        console.log("Create3Factory   ", f);
    }

    /// @dev Idempotent: skips (and logs) if the predicted address already has code.
    function _deploy3(address deployer, string memory name, bytes memory initCode) internal returns (address d) {
        address predicted = _predict(deployer, name);
        if (predicted.code.length != 0) {
            console.log(string.concat("exists  ", name), predicted);
            return predicted;
        }
        d = Create3Factory(_factoryAddress()).deploy(_salt(name), initCode);
        require(d == predicted, string.concat("CREATE3 address mismatch: ", name));
        console.log(string.concat("deployed ", name), d);
    }

    /// @dev Artifact lookup that doesn't need the source at compile time.
    function _code(string memory artifact) internal view returns (bytes memory c) {
        c = vm.getCode(artifact);
        require(c.length != 0, string.concat("missing artifact ", artifact));
    }

    // ================================================================== constructor configs
    function _hubCoreCfg(Addrs memory a, address guardian) internal view returns (HubCoreConfig memory c) {
        c.verifier = a.verifier;
        c.poseidonT3 = a.poseidonT3;
        c.depositManager = a.depositManager;
        c.liquidityManager = a.liquidityManager;
        c.guardian = guardian;
        c.baseChainId = baseChainId;
        c.baseAdapter = a.opAdapter;
        c.arbChainId = arbChainId;
        c.arbAdapter = a.arbAdapter;
        c.phiBps = _u(".params.phiBps");
        c.relayerFeeBucket = _u(".params.relayerFeeBucket");
        c.minWithdrawEth = _u(".params.minWithdraw");
        c.minWithdrawBase = _u(".params.minWithdraw");
        c.minWithdrawArb = _u(".params.minWithdraw");
    }

    function _depositManagerCfg(Addrs memory a, External memory x) internal view returns (DepositManagerConfig memory c) {
        c.hub = a.hubCore;
        c.liquidityManager = a.liquidityManager;
        c.stakeManager = a.stakeManager;
        c.poseidonT4 = a.poseidonT4;
        c.usdc = x.hubUsdc;
        c.baseChainId = baseChainId;
        c.baseAdapter = a.opAdapter;
        c.baseSpoke = a.baseSpoke;
        c.arbChainId = arbChainId;
        c.arbAdapter = a.arbAdapter;
        c.arbSpoke = a.arbSpoke;
        c.baseSettleInsert = _u(".params.settleFee.insert");
        c.baseSettleFinal = _u(".params.settleFee.final");
        c.arbSettleInsert = _u(".params.settleFee.insert");
        c.arbSettleFinal = _u(".params.settleFee.final");
        c.minDeposit = _u(".params.minDeposit");
        c.maxDeposit = _u(".params.maxDeposit");
        c.maxFastDeposit = _u(".params.maxFastDeposit");
        c.tvlCapEth = _perChain(".params.tvlCap", hubChainId);
        c.betaNum = _uAt(".params.beta", 0);
        c.betaDen = _uAt(".params.beta", 1);
        c.maxDepositHardMax = _u(".bounds.maxDepositHardMax");
        c.maxFastDepositHardMax = _u(".bounds.maxFastDepositHardMax");
        c.tvlCapHardMax = _u(".bounds.tvlCapHardMax");
        c.betaMaxNum = _uAt(".bounds.betaMax", 0);
        c.betaMaxDen = _uAt(".bounds.betaMax", 1);
    }

    function _stakeManagerCfg(Addrs memory a, External memory x) internal view returns (StakeManagerConfig memory c) {
        c.usdc = x.hubUsdc;
        c.depositManager = a.depositManager;
        c.liquidityManager = a.liquidityManager;
        c.baseChainId = baseChainId;
        c.arbChainId = arbChainId;
        c.sMin = _u(".params.sMin");
        c.kNum = _uAt(".params.k", 0);
        c.kDen = _uAt(".params.k", 1);
        c.thetaNum = _uAt(".params.theta", 0);
        c.thetaDen = _uAt(".params.theta", 1);
        c.omegaBps = _u(".params.omegaBps");
        c.evictionMarginBps = _u(".params.evictionMarginBps");
        c.epochSeconds = uint64(_u(".params.epochSeconds"));
        c.unbondSeconds = uint64(_u(".params.unbondSeconds"));
    }

    function _liquidityManagerCfg(Addrs memory a, External memory x)
        internal
        view
        returns (LiquidityManagerConfig memory c)
    {
        c.usdc = x.hubUsdc;
        c.hub = a.hubCore;
        c.depositManager = a.depositManager;
        c.stakeManager = a.stakeManager;
        c.tokenMessengerV2 = x.hubTokenMessenger;
        c.ethDomain = uint32(_u(".hub.cctp.domain"));
        c.baseChainId = baseChainId;
        c.baseAdapter = a.opAdapter;
        c.baseSpoke = a.baseSpoke;
        c.baseDomain = uint32(_u(_sp(baseIdx, ".cctp.domain")));
        c.arbChainId = arbChainId;
        c.arbAdapter = a.arbAdapter;
        c.arbSpoke = a.arbSpoke;
        c.arbDomain = uint32(_u(_sp(arbIdx, ".cctp.domain")));
        c.alphaVBps = _u(".params.feeSplitBps.validators");
        c.alphaLPBps = _u(".params.feeSplitBps.lps");
        c.alphaInsBps = _u(".params.feeSplitBps.insurance");
        c.targetEthBps = _perChain(".params.targetBps", hubChainId);
        c.targetBaseBps = _perChain(".params.targetBps", baseChainId);
        c.targetArbBps = _perChain(".params.targetBps", arbChainId);
        c.targetBpsMin = _u(".bounds.targetBpsMin");
        c.targetBpsMax = _u(".bounds.targetBpsMax");
        c.minRebalance = _u(".params.minRebalance");
    }

    function _opAdapterCfg(Addrs memory a, External memory x) internal view returns (OpStackHubAdapterConfig memory c) {
        c.l1Messenger = x.baseL1Messenger;
        c.spoke = a.baseSpoke;
        c.spokeChainId = baseChainId;
        c.hub = a.hubCore;
        c.liquidityManager = a.liquidityManager;
        c.depositManager = a.depositManager;
        c.minGasL2 = uint32(_u(".params.minGasL2"));
    }

    function _arbAdapterCfg(Addrs memory a, External memory x)
        internal
        view
        returns (ArbitrumHubAdapterConfig memory c)
    {
        c.inbox = x.arbInbox;
        c.bridge = x.arbBridge;
        c.spoke = a.arbSpoke;
        c.spokeChainId = arbChainId;
        c.hub = a.hubCore;
        c.liquidityManager = a.liquidityManager;
        c.depositManager = a.depositManager;
        c.minGasL2 = _u(".params.minGasL2");
    }

    function _spokeCfg(bool isBase, Addrs memory a, External memory x) internal view returns (SpokeConfig memory c) {
        c.usdc = isBase ? x.baseUsdc : x.arbUsdc;
        c.hubChainId = hubChainId;
        c.hubAdapter = isBase ? a.opAdapter : a.arbAdapter;
        c.tokenMessengerV2 = isBase ? x.baseTokenMessenger : x.arbTokenMessenger;
        c.minDeposit = _u(".params.minDeposit");
        c.maxDeposit = _u(".params.maxDeposit");
        c.tvlCap = _perChain(".params.tvlCap", isBase ? baseChainId : arbChainId);
        c.settleFeeInsert = _u(".params.settleFee.insert");
        c.settleFeeFinal = _u(".params.settleFee.final");
        c.maxCheckpoint = uint64(_u(".params.maxCheckpoint"));
        c.minEmptyCheckpointInterval = uint64(_u(".params.minEmptyCheckpointInterval"));
        c.minGasL1 = uint32(_u(".params.minGasL1"));
    }

    // ================================================================== high-level deploy steps
    /// @dev Everything on the hub chain, in PRD 14.5 order. Caller must be broadcasting as `deployer`.
    function _deployHubContracts(address deployer, Addrs memory a, External memory x) internal {
        require(block.chainid == hubChainId, "wrong chain: not the hub");
        _ensureFactory();
        _deploy3(deployer, N_POSEIDON_T3, _code("PoseidonT3.sol:PoseidonT3"));
        _deploy3(deployer, N_POSEIDON_T4, _code("PoseidonT4.sol:PoseidonT4"));
        _deploy3(deployer, N_VERIFIER, _code("Groth16Verifier.sol:Groth16Verifier"));
        _deploy3(
            deployer,
            N_STAKE,
            abi.encodePacked(_code("StakeManager.sol:StakeManager"), abi.encode(_stakeManagerCfg(a, x)))
        );
        _deploy3(
            deployer,
            N_LIQUIDITY,
            abi.encodePacked(_code("LiquidityManager.sol:LiquidityManager"), abi.encode(_liquidityManagerCfg(a, x)))
        );
        _deploy3(
            deployer,
            N_DEPOSIT,
            abi.encodePacked(_code("DepositManager.sol:DepositManager"), abi.encode(_depositManagerCfg(a, x)))
        );
        _deploy3(
            deployer, N_HUB, abi.encodePacked(_code("HubCore.sol:HubCore"), abi.encode(_hubCoreCfg(a, _guardian(deployer))))
        );
        _deploy3(
            deployer,
            N_OP_ADAPTER,
            abi.encodePacked(_code("OpStackHubAdapter.sol:OpStackHubAdapter"), abi.encode(_opAdapterCfg(a, x)))
        );
        _deploy3(
            deployer,
            N_ARB_ADAPTER,
            abi.encodePacked(_code("ArbitrumHubAdapter.sol:ArbitrumHubAdapter"), abi.encode(_arbAdapterCfg(a, x)))
        );
    }

    /// @dev The spoke of the current chain. Caller must be broadcasting as `deployer`.
    function _deploySpokeContract(address deployer, bool isBase, Addrs memory a, External memory x)
        internal
        returns (address s)
    {
        require(block.chainid == (isBase ? baseChainId : arbChainId), "wrong chain for this spoke");
        _ensureFactory();
        if (isBase) {
            s = _deploy3(
                deployer,
                N_BASE_SPOKE,
                abi.encodePacked(
                    _code("OpStackSpoke.sol:OpStackSpoke"), abi.encode(_spokeCfg(true, a, x), x.baseL2Messenger)
                )
            );
        } else {
            s = _deploy3(
                deployer,
                N_ARB_SPOKE,
                abi.encodePacked(_code("ArbitrumSpoke.sol:ArbitrumSpoke"), abi.encode(_spokeCfg(false, a, x)))
            );
        }
    }

    // ================================================================== deployments/<env>.json
    function _deploymentsPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", env, ".json");
    }

    function _spokeJson(string memory name, string memory stack, uint256 deployBlock, address usdc_, address spoke)
        internal
        returns (string memory)
    {
        string memory k = string.concat("spoke-", name);
        string memory contracts_ = vm.serializeAddress(string.concat(k, "-c"), "Spoke", spoke);
        vm.serializeString(k, "name", name);
        vm.serializeString(k, "stack", stack);
        vm.serializeUint(k, "deployBlock", deployBlock);
        vm.serializeAddress(k, "usdc", usdc_);
        return vm.serializeString(k, "contracts", contracts_);
    }

    function _hubJson(Addrs memory a, uint256 deployBlock, address usdc_) internal returns (string memory) {
        string memory c = "hub-c";
        vm.serializeAddress(c, N_HUB, a.hubCore);
        vm.serializeAddress(c, N_DEPOSIT, a.depositManager);
        vm.serializeAddress(c, N_STAKE, a.stakeManager);
        vm.serializeAddress(c, N_LIQUIDITY, a.liquidityManager);
        vm.serializeAddress(c, N_VERIFIER, a.verifier);
        vm.serializeAddress(c, N_POSEIDON_T3, a.poseidonT3);
        vm.serializeAddress(c, N_POSEIDON_T4, a.poseidonT4);
        vm.serializeAddress(c, N_OP_ADAPTER, a.opAdapter);
        string memory contracts_ = vm.serializeAddress(c, N_ARB_ADAPTER, a.arbAdapter);
        vm.serializeUint("hub", "chainId", hubChainId);
        vm.serializeUint("hub", "deployBlock", deployBlock);
        vm.serializeAddress("hub", "usdc", usdc_);
        return vm.serializeString("hub", "contracts", contracts_);
    }

    /// @dev Full file with predicted addresses and zero deploy blocks / unknown USDC; each deploy
    ///      step then replaces its own section. Written fresh by the hub step, or by a spoke step
    ///      when the file doesn't exist yet.
    function _writeSkeleton(address deployer, Addrs memory a, External memory x) internal {
        string memory spokes = "spokes";
        vm.serializeString(
            spokes,
            vm.toString(uint256(baseChainId)),
            _spokeJson(vm.parseJsonString(cfg, _sp(baseIdx, ".name")), "opstack", 0, x.baseUsdc, a.baseSpoke)
        );
        string memory spokesJson = vm.serializeString(
            spokes,
            vm.toString(uint256(arbChainId)),
            _spokeJson(vm.parseJsonString(cfg, _sp(arbIdx, ".name")), "arbitrum", 0, x.arbUsdc, a.arbSpoke)
        );
        string memory root = "root";
        vm.serializeString(root, "environment", env);
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeAddress(root, "create3Factory", a.factory);
        vm.serializeString(root, "hub", _hubJson(a, 0, x.hubUsdc));
        string memory out = vm.serializeString(root, "spokes", spokesJson);
        if (_isLocal()) {
            string memory m = "mocks";
            vm.serializeString(m, vm.toString(uint256(hubChainId)), "{}");
            vm.serializeString(m, vm.toString(uint256(baseChainId)), "{}");
            string memory mocks = vm.serializeString(m, vm.toString(uint256(arbChainId)), "{}");
            out = vm.serializeString(root, "mocks", mocks);
        }
        vm.writeJson(out, _deploymentsPath());
    }

    function _writeHubSection(Addrs memory a, uint256 deployBlock, address usdc_) internal {
        vm.writeJson(_hubJson(a, deployBlock, usdc_), _deploymentsPath(), ".hub");
    }

    function _writeSpokeSection(bool isBase, address usdc_, address spoke, uint256 deployBlock) internal {
        uint256 i = isBase ? baseIdx : arbIdx;
        string memory json = _spokeJson(
            vm.parseJsonString(cfg, _sp(i, ".name")), isBase ? "opstack" : "arbitrum", deployBlock, usdc_, spoke
        );
        vm.writeJson(
            json, _deploymentsPath(), string.concat(".spokes.", vm.toString(uint256(isBase ? baseChainId : arbChainId)))
        );
    }

    function _deploymentsExist() internal returns (bool) {
        return vm.isFile(_deploymentsPath());
    }

    /// @dev Writes a fresh skeleton unless a file for the same deployer already exists (so re-running
    ///      one step never wipes the sections written by the others).
    function _ensureSkeleton(address deployer, Addrs memory a, External memory x) internal {
        if (_deploymentsExist()) {
            string memory existing = vm.readFile(_deploymentsPath());
            if (
                vm.keyExistsJson(existing, ".deployer") && vm.parseJsonAddress(existing, ".deployer") == deployer
                    && vm.parseJsonAddress(existing, ".create3Factory") == a.factory
            ) return;
        }
        _writeSkeleton(deployer, a, x);
    }

    function _logAddrs(Addrs memory a) internal pure {
        console.log("Create3Factory     ", a.factory);
        console.log("PoseidonT3         ", a.poseidonT3);
        console.log("PoseidonT4         ", a.poseidonT4);
        console.log("Groth16Verifier    ", a.verifier);
        console.log("StakeManager       ", a.stakeManager);
        console.log("LiquidityManager   ", a.liquidityManager);
        console.log("DepositManager     ", a.depositManager);
        console.log("HubCore            ", a.hubCore);
        console.log("OpStackHubAdapter  ", a.opAdapter);
        console.log("ArbitrumHubAdapter ", a.arbAdapter);
        console.log("Spoke (Base)       ", a.baseSpoke);
        console.log("Spoke (Arbitrum)   ", a.arbSpoke);
    }
}
