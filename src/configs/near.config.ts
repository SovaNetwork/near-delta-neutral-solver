export const NEAR_CONFIG = {
    networkId: process.env.NEAR_NETWORK_ID || 'mainnet',
    // Use free tier + fallback to avoid rate limits (same as AMM solver)
    nodeUrl: process.env.NEAR_RPC_URL || 'https://1rpc.io/near',
    walletUrl: 'https://wallet.near.org',
    helperUrl: 'https://helper.mainnet.near.org',
    explorerUrl: 'https://explorer.near.org',

    SOLVER_ID: process.env.SOLVER_ID || 'solver.near',
    SOLVER_PRIVATE_KEY: process.env.SOLVER_PRIVATE_KEY || '',

    INTENTS_CONTRACT_ID: process.env.INTENTS_CONTRACT_ID || 'intents.near',
};
