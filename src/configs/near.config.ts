export const NEAR_CONFIG = {
    networkId: process.env.NEAR_NETWORK_ID || 'mainnet',
    // dRPC has 210M CU/month free tier - most generous public RPC
    // Alternatives: https://near.blockpi.network/v1/rpc/public (50M/month), https://near.lava.build
    nodeUrl: process.env.NEAR_RPC_URL || 'https://near.drpc.org',
    walletUrl: 'https://wallet.near.org',
    helperUrl: 'https://helper.mainnet.near.org',
    explorerUrl: 'https://explorer.near.org',

    SOLVER_ID: process.env.SOLVER_ID || 'solver.near',
    SOLVER_PRIVATE_KEY: process.env.SOLVER_PRIVATE_KEY || '',

    INTENTS_CONTRACT_ID: process.env.INTENTS_CONTRACT_ID || 'intents.near',
};
