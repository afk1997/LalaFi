// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Constructor configs. Every protocol contract takes exactly one of these structs, so the
///        deploy scripts (contracts/script/**) can be written independently of the implementations.
/// @dev All addresses are predicted CREATE3 addresses (docs/IMPLEMENTATION.md). Everything here is
///      stored as an immutable (or, for bounded guardian-tunable values, as initial storage plus
///      immutable hard bounds). Fractions are numerator/denominator pairs; *Bps are basis points.

struct HubCoreConfig {
    address verifier;
    address poseidonT3;
    address depositManager;
    address liquidityManager;
    address guardian;
    uint64 baseChainId;
    address baseAdapter;
    uint64 arbChainId;
    address arbAdapter;
    uint256 phiBps; // protocol fee, 10 = 0.10%
    uint256 relayerFeeBucket;
    uint256 minWithdrawEth;
    uint256 minWithdrawBase;
    uint256 minWithdrawArb;
}

struct DepositManagerConfig {
    address hub;
    address liquidityManager;
    address stakeManager;
    address poseidonT4;
    address usdc;
    uint64 baseChainId;
    address baseAdapter;
    address baseSpoke;
    uint64 arbChainId;
    address arbAdapter;
    address arbSpoke;
    uint256 baseSettleInsert;
    uint256 baseSettleFinal;
    uint256 arbSettleInsert;
    uint256 arbSettleFinal;
    // guardian-tunable within hard bounds
    uint256 minDeposit; // immutable
    uint256 maxDeposit;
    uint256 maxFastDeposit;
    uint256 tvlCapEth;
    uint256 betaNum;
    uint256 betaDen;
    uint256 maxDepositHardMax;
    uint256 maxFastDepositHardMax;
    uint256 tvlCapHardMax;
    uint256 betaMaxNum;
    uint256 betaMaxDen;
}

struct StakeManagerConfig {
    address usdc;
    address depositManager;
    address liquidityManager;
    uint64 baseChainId;
    uint64 arbChainId;
    uint256 sMin;
    uint256 kNum; // k = 3/2
    uint256 kDen;
    uint256 thetaNum; // theta = 2/3
    uint256 thetaDen;
    uint256 omegaBps; // prover reward cap, 1000 = 10%
    uint256 evictionMarginBps; // 100 = 1%
    uint64 epochSeconds;
    uint64 unbondSeconds;
}

struct LiquidityManagerConfig {
    address usdc;
    address hub;
    address depositManager;
    address stakeManager;
    address tokenMessengerV2; // CCTP V2 on Ethereum
    uint32 ethDomain; // 0
    uint64 baseChainId;
    address baseAdapter;
    address baseSpoke;
    uint32 baseDomain; // 6
    uint64 arbChainId;
    address arbAdapter;
    address arbSpoke;
    uint32 arbDomain; // 3
    uint256 alphaVBps; // 3000
    uint256 alphaLPBps; // 6000
    uint256 alphaInsBps; // 1000
    uint256 targetEthBps; // guardian-tunable within [targetBpsMin, targetBpsMax]
    uint256 targetBaseBps;
    uint256 targetArbBps;
    uint256 targetBpsMin;
    uint256 targetBpsMax;
    uint256 minRebalance;
}

struct SpokeConfig {
    address usdc;
    uint64 hubChainId;
    address hubAdapter;
    address tokenMessengerV2; // CCTP V2 on this L2
    uint256 minDeposit;
    uint256 maxDeposit;
    uint256 tvlCap;
    uint256 settleFeeInsert;
    uint256 settleFeeFinal;
    uint64 maxCheckpoint; // items per checkpoint
    uint64 minEmptyCheckpointInterval; // in l2 blocks
    uint32 minGasL1; // OP only: gas for the L1 leg of sendMessage
}

struct OpStackHubAdapterConfig {
    address l1Messenger; // L1CrossDomainMessenger (proxy) of the OP chain
    address spoke;
    uint64 spokeChainId;
    address hub;
    address liquidityManager;
    address depositManager;
    uint32 minGasL2;
}

struct ArbitrumHubAdapterConfig {
    address inbox;
    address bridge;
    address spoke;
    uint64 spokeChainId;
    address hub;
    address liquidityManager;
    address depositManager;
    uint256 minGasL2; // minimum retryable gasLimit accepted
}
