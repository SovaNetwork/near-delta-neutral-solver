export interface TokenConfig {
    id: string;
    symbol: string;
    decimals: number;
    pow10: number;
}

export type BtcTokenConfig = TokenConfig;

// Pre-build token arrays with pow10
const BTC_TOKENS: BtcTokenConfig[] = [
    { id: 'btc.omft.near', symbol: 'BTC', decimals: 8, pow10: 1e8 },
    { id: 'eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near', symbol: 'wBTC', decimals: 8, pow10: 1e8 },
    { id: 'base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near', symbol: 'cbBTC-BASE', decimals: 8, pow10: 1e8 },
];

const USD_TOKENS: TokenConfig[] = [
    // { id: 'eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', symbol: 'USDT', decimals: 6, pow10: 1e6 },
    { id: 'eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', symbol: 'USDC', decimals: 6, pow10: 1e6 },
];

// Pre-build Maps for O(1) lookup (created once at module load)
const BTC_MAP = new Map<string, BtcTokenConfig>(BTC_TOKENS.map(t => [t.id, t]));
const USD_MAP = new Map<string, TokenConfig>(USD_TOKENS.map(t => [t.id, t]));

export const BTC_ONLY_CONFIG = {
    BTC_ONLY_MODE: true,

    // Token arrays
    BTC_TOKENS,
    USD_TOKENS,

    // Derived array of token IDs for quick lookup
    get BTC_TOKEN_IDS(): string[] {
        return BTC_TOKENS.map(t => t.id);
    },

    // O(1) token checks using pre-built Maps
    isBtcToken: (tokenId: string): boolean => BTC_MAP.has(tokenId),
    isUsdToken: (tokenId: string): boolean => USD_MAP.has(tokenId),

    // O(1) config lookups
    getBtcTokenConfig: (tokenId: string): BtcTokenConfig | undefined => BTC_MAP.get(tokenId),
    getUsdTokenConfig: (tokenId: string): TokenConfig | undefined => USD_MAP.get(tokenId),

    // Get human-readable symbol for BTC token
    getBtcSymbol: (tokenId: string): string => BTC_MAP.get(tokenId)?.symbol ?? 'BTC',

    // Get decimals/pow10 with defaults
    getBtcDecimals: (tokenId: string): number => BTC_MAP.get(tokenId)?.decimals ?? 8,
    getUsdDecimals: (tokenId: string): number => USD_MAP.get(tokenId)?.decimals ?? 6,
    getBtcPow10: (tokenId: string): number => BTC_MAP.get(tokenId)?.pow10 ?? 1e8,
    getUsdPow10: (tokenId: string): number => USD_MAP.get(tokenId)?.pow10 ?? 1e6,

    // Legacy single token ID (for backwards compat, uses first USD token)
    get USDT_TOKEN_ID(): string {
        return USD_TOKENS[0]?.id ?? 'eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
    },
    USDT_DECIMALS: 6,

    MAX_BTC_INVENTORY: parseFloat(process.env.MAX_BTC_INVENTORY || '5.0'),
    MIN_USDT_RESERVE: parseFloat(process.env.MIN_USDT_RESERVE || '2000.0'),

    TARGET_SPREAD_BIPS: parseInt(process.env.TARGET_SPREAD_BIPS || '200', 10), // 2%

    // Risk
    MIN_MARGIN_THRESHOLD: parseFloat(process.env.MIN_MARGIN_THRESHOLD || '1000.0'), // Min USDC margin on HL
    // Maximum negative funding rate we'll tolerate for short positions
    // When funding is negative, shorts PAY longs. We reject if more negative than this threshold.
    // e.g., -0.0005 = -0.05%/hr = we reject quotes if funding < -0.05%/hr
    MAX_NEGATIVE_FUNDING_RATE: parseFloat(process.env.MAX_NEGATIVE_FUNDING_RATE || process.env.MIN_HOURLY_FUNDING_RATE || '-0.0005'),
    DRIFT_THRESHOLD_BTC: parseFloat(process.env.DRIFT_THRESHOLD_BTC || '0.001'),
    MIN_TRADE_SIZE_BTC: parseFloat(process.env.MIN_TRADE_SIZE_BTC || '0.0001'),
    MAX_TRADE_SIZE_BTC: parseFloat(process.env.MAX_TRADE_SIZE_BTC || '1.0'),

    // Hedge execution
    HEDGE_SLIPPAGE_BPS: parseInt(process.env.HEDGE_SLIPPAGE_BPS || '30', 10), // 0.3% slippage tolerance
    MAX_ORDERBOOK_AGE_MS: parseInt(process.env.MAX_ORDERBOOK_AGE_MS || '2000', 10), // Reject quotes if orderbook stale >2s

    // Circuit breaker - set to 'false' to disable hedging (for debugging/testing)
    HEDGING_ENABLED: process.env.HEDGING_ENABLED !== 'false',
};
