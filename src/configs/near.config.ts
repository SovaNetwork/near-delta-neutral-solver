// RPC endpoints for failover (order = priority)
// FASTNEAR is fastest, Lava and dRPC as backups
const DEFAULT_RPC_URLS = [
    'https://free.rpc.fastnear.com',
    'https://near.lava.build',
    'https://near.drpc.org',
];

// Parse RPC URLs from env (comma-separated) or use defaults
const parseRpcUrls = (): string[] => {
    const envUrls = process.env.NEAR_RPC_URLS;
    if (envUrls) {
        return envUrls.split(',').map(url => url.trim()).filter(Boolean);
    }
    // Also support single URL for backwards compatibility
    const singleUrl = process.env.NEAR_RPC_URL;
    if (singleUrl) {
        return [singleUrl, ...DEFAULT_RPC_URLS.filter(u => u !== singleUrl)];
    }
    return DEFAULT_RPC_URLS;
};

export const NEAR_CONFIG = {
    networkId: process.env.NEAR_NETWORK_ID || 'mainnet',
    // Primary RPC URL (first in list, for near-api-js connect())
    nodeUrl: parseRpcUrls()[0],
    // All RPC URLs for failover
    rpcUrls: parseRpcUrls(),
    walletUrl: 'https://wallet.near.org',
    helperUrl: 'https://helper.mainnet.near.org',
    explorerUrl: 'https://explorer.near.org',

    SOLVER_ID: process.env.SOLVER_ID || 'solver.near',
    SOLVER_PRIVATE_KEY: process.env.SOLVER_PRIVATE_KEY || '',

    INTENTS_CONTRACT_ID: process.env.INTENTS_CONTRACT_ID || 'intents.near',
};
