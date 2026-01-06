import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
import BigNumber from 'bignumber.js';

export class InventoryStateService {
    private emergencyMode = false;
    private cachedDirection: 'BUY_BTC_ONLY' | 'SELL_BTC_ONLY' | 'BOTH' | 'NONE' = 'NONE';
    private lastCacheTime = 0;
    private readonly CACHE_TTL_MS = 5000; // Cache for 5 seconds

    constructor(
        private nearService: NearService,
        private hyperliquidService: HyperliquidService
    ) { }

    setEmergencyMode(enabled: boolean) {
        this.emergencyMode = enabled;
        if (enabled) console.warn("!!! EMERGENCY MODE ENABLED - SWITCHING TO SELL ONLY !!!");
    }

    async getQuoteDirection(): Promise<'BUY_BTC_ONLY' | 'SELL_BTC_ONLY' | 'BOTH' | 'NONE'> {
        if (this.emergencyMode) return 'SELL_BTC_ONLY';

        // Return cached result if still valid
        const now = Date.now();
        if (now - this.lastCacheTime < this.CACHE_TTL_MS) {
            return this.cachedDirection;
        }

        const margin = await this.hyperliquidService.getAvailableMargin();
        if (margin < BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD) {
            console.warn(`Low Margin: ${margin}. Halting Quotes.`);
            this.cachedDirection = 'NONE';
            this.lastCacheTime = now;
            return 'NONE';
        }

        const btcBalanceBN = await this.nearService.getBalance(BTC_ONLY_CONFIG.BTC_TOKEN_ID);
        const usdtBalanceBN = await this.nearService.getBalance(BTC_ONLY_CONFIG.USDT_TOKEN_ID);

        // Convert to float (assuming 8 decimals for BTC, 6 for USDT)
        const btcBalance = btcBalanceBN.div(1e8).toNumber();
        const usdtBalance = usdtBalanceBN.div(1e6).toNumber();

        const canBuyBtc = usdtBalanceBN.gt(new BigNumber(BTC_ONLY_CONFIG.MIN_USDT_RESERVE).multipliedBy(1e6)) &&
            btcBalanceBN.lt(new BigNumber(BTC_ONLY_CONFIG.MAX_BTC_INVENTORY).multipliedBy(1e8));

        const canSellBtc = btcBalanceBN.gt(new BigNumber(BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC).multipliedBy(1e8));

        // Determine direction and cache it
        let direction: 'BUY_BTC_ONLY' | 'SELL_BTC_ONLY' | 'BOTH' | 'NONE';
        if (canBuyBtc && canSellBtc) direction = 'BOTH';
        else if (canBuyBtc) direction = 'BUY_BTC_ONLY';
        else if (canSellBtc) direction = 'SELL_BTC_ONLY';
        else direction = 'NONE';

        this.cachedDirection = direction;
        this.lastCacheTime = now;

        return direction;
    }
}
