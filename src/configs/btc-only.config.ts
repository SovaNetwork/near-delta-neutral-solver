export const BTC_ONLY_CONFIG = {
    BTC_ONLY_MODE: true,

    // Active BTC Token ID (Select ONE via .env or hardcode here)
    // Options:
    // 1. wBTC (Eth): eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near
    // 2. cbBTC (Base): base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near
    // 3. BTC (Spot): btc.omft.near
    BTC_TOKEN_ID: process.env.BTC_TOKEN_ID || 'eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near',

    USDC_TOKEN_ID: process.env.USDC_TOKEN_ID || '17208628f84f5d6ad33f05d896584acf65e55331.factory.bridge.near',

    MAX_BTC_INVENTORY: parseFloat(process.env.MAX_BTC_INVENTORY || '5.0'),
    MIN_USDC_RESERVE: parseFloat(process.env.MIN_USDC_RESERVE || '2000.0'),

    TARGET_SPREAD_BIPS: parseInt(process.env.TARGET_SPREAD_BIPS || '200', 10), // 2%

    // Risk
    MIN_MARGIN_THRESHOLD: parseFloat(process.env.MIN_MARGIN_THRESHOLD || '1000.0'), // Min USDC margin on HL
    MIN_HOURLY_FUNDING_RATE: parseFloat(process.env.MIN_HOURLY_FUNDING_RATE || '-0.0005'), // -0.05% per hour
    DRIFT_THRESHOLD_BTC: parseFloat(process.env.DRIFT_THRESHOLD_BTC || '0.001'),
};
