import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
import BigNumber from 'bignumber.js';

export class InventoryStateService {
    private emergencyMode = false;

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

        const margin = await this.hyperliquidService.getAvailableMargin();
        if (margin < BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD) {
            console.warn(`Low Margin: ${margin}. Halting Quotes.`);
            return 'NONE';
        }

        const btcBalanceBN = await this.nearService.getBalance(BTC_ONLY_CONFIG.BTC_TOKEN_ID);
        const usdtBalanceBN = await this.nearService.getBalance(BTC_ONLY_CONFIG.USDT_TOKEN_ID);

        // Convert to float (assuming 8 decimals for BTC, 6 for USDC usually, but checking config)
        // Standard WBTC is 8 decimals. USDC is 6.
        // Convert to float (assuming 8 decimals for BTC, 6 for USDT)
        // Standard WBTC is 8 decimals. USDT on NEAR is 6 decimals.
        const btcBalance = btcBalanceBN.div(1e8).toNumber();
        const usdtBalance = usdtBalanceBN.div(1e6).toNumber();

        const canBuyBtc = usdtBalance > BTC_ONLY_CONFIG.MIN_USDT_RESERVE && btcBalance < BTC_ONLY_CONFIG.MAX_BTC_INVENTORY;
        const canSellBtc = btcBalance > 0.0001; // Min trade size equivalent

        // Flexible Flow: Allow BOTH if conditions met.
        if (canBuyBtc && canSellBtc) return 'BOTH';
        if (canBuyBtc) return 'BUY_BTC_ONLY';
        if (canSellBtc) return 'SELL_BTC_ONLY';

        return 'NONE';
    }
}
