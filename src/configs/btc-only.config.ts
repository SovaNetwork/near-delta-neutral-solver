export interface BtcTokenConfig {
    id: string;
    symbol: string;
    decimals: number;
}

export const BTC_ONLY_CONFIG = {
    BTC_ONLY_MODE: true,

    // Supported BTC tokens with their configuration
    BTC_TOKENS: [
        { id: 'btc.omft.near', symbol: 'BTC', decimals: 8 },
        { id: 'eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near', symbol: 'wBTC', decimals: 8 },
        { id: 'base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near', symbol: 'cbBTC', decimals: 8 },
    ] as BtcTokenConfig[],

    // Derived array of token IDs for quick lookup
    get BTC_TOKEN_IDS(): string[] {
        return this.BTC_TOKENS.map(t => t.id);
    },

    // Helper to check if a token is a supported BTC type
    isBtcToken: (tokenId: string): boolean => {
        return BTC_ONLY_CONFIG.BTC_TOKENS.some(t => t.id === tokenId);
    },

    // Get token config by ID
    getBtcTokenConfig: (tokenId: string): BtcTokenConfig | undefined => {
        return BTC_ONLY_CONFIG.BTC_TOKENS.find(t => t.id === tokenId);
    },

    // Get human-readable symbol for BTC token
    getBtcSymbol: (tokenId: string): string => {
        const config = BTC_ONLY_CONFIG.getBtcTokenConfig(tokenId);
        return config?.symbol ?? 'BTC';
    },

    // Get decimals for BTC token (defaults to 8)
    getBtcDecimals: (tokenId: string): number => {
        const config = BTC_ONLY_CONFIG.getBtcTokenConfig(tokenId);
        return config?.decimals ?? 8;
    },

    // USDT configuration
    USDT_TOKEN_ID: process.env.USDT_TOKEN_ID || 'eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
    USDT_DECIMALS: 6,

    MAX_BTC_INVENTORY: parseFloat(process.env.MAX_BTC_INVENTORY || '5.0'),
    MIN_USDT_RESERVE: parseFloat(process.env.MIN_USDT_RESERVE || '2000.0'),

    TARGET_SPREAD_BIPS: parseInt(process.env.TARGET_SPREAD_BIPS || '200', 10), // 2%

    // Risk
    MIN_MARGIN_THRESHOLD: parseFloat(process.env.MIN_MARGIN_THRESHOLD || '1000.0'), // Min USDC margin on HL
    MIN_HOURLY_FUNDING_RATE: parseFloat(process.env.MIN_HOURLY_FUNDING_RATE || '-0.0005'), // -0.05% per hour
    DRIFT_THRESHOLD_BTC: parseFloat(process.env.DRIFT_THRESHOLD_BTC || '0.001'),
    MIN_TRADE_SIZE_BTC: parseFloat(process.env.MIN_TRADE_SIZE_BTC || '0.0001'),
    MAX_TRADE_SIZE_BTC: parseFloat(process.env.MAX_TRADE_SIZE_BTC || '1.0'),

    // Hedge execution
    HEDGE_SLIPPAGE_BPS: parseInt(process.env.HEDGE_SLIPPAGE_BPS || '30', 10), // 0.3% slippage tolerance
    MAX_ORDERBOOK_AGE_MS: parseInt(process.env.MAX_ORDERBOOK_AGE_MS || '2000', 10), // Reject quotes if orderbook stale >2s
};
