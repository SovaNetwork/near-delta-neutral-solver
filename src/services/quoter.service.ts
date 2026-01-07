import { InventoryStateService } from './inventory-manager.service';
import { HyperliquidService } from './hyperliquid.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
import { NearService } from './near.service';
import { LoggerService } from './logger.service';

export interface QuoteRequest {
    token_in: string;
    token_out: string;
    amount_in: string;
}

export class QuoterService {
    constructor(
        private inventoryManager: InventoryStateService,
        private hyperliquidService: HyperliquidService,
        private nearService: NearService,
        private logger: LoggerService
    ) { }

    getQuote(request: QuoteRequest) {
        try {
            // 1. Validate Assets
            const isBtcIn = request.token_in === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
            const isUsdtIn = request.token_in === BTC_ONLY_CONFIG.USDT_TOKEN_ID;
            const isBtcOut = request.token_out === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
            const isUsdtOut = request.token_out === BTC_ONLY_CONFIG.USDT_TOKEN_ID;

            if (!((isBtcIn && isUsdtOut) || (isUsdtIn && isBtcOut))) {
                return undefined;
            }

            // 2. Determine if we are Buying or Selling BTC
            const weAreBuyingBtc = isBtcIn;

            // 3. Calculate Price
            const decimalsIn = isBtcIn ? 8 : 6;
            const decimalsOut = isBtcOut ? 8 : 6;

            const amountInFloat = parseFloat(request.amount_in) / Math.pow(10, decimalsIn);

            // 4. Size Estimation with early validation
            let btcSize = 0;

            if (weAreBuyingBtc) {
                btcSize = amountInFloat;
            } else {
                const probePrice = this.hyperliquidService.getHedgePrice('ask', 0.001);
                let estimatedSize = amountInFloat / probePrice;
                
                // Early size validation before querying full depth
                if (estimatedSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC) {
                    return undefined;
                }
                if (estimatedSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
                    return undefined;
                }
                
                const refinedPrice = this.hyperliquidService.getHedgePrice('ask', estimatedSize);
                btcSize = amountInFloat / refinedPrice;
            }

            // Size Validation
            if (btcSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC) {
                return undefined;
            }
            if (btcSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
                return undefined;
            }

            // 5. All checks are now synchronous - no network I/O
            const hedgeDirection = weAreBuyingBtc ? 'short' : 'long';

            const direction = this.inventoryManager.getQuoteDirection();
            const hasCapacity = this.inventoryManager.checkPositionCapacity(hedgeDirection, btcSize);
            const fundingRate = weAreBuyingBtc ? this.inventoryManager.getFundingRate() : 0;

            // Check inventory direction
            if (weAreBuyingBtc) {
                if (direction !== 'BUY_BTC_ONLY' && direction !== 'BOTH') {
                    return undefined;
                }
            } else {
                if (direction !== 'SELL_BTC_ONLY' && direction !== 'BOTH') {
                    return undefined;
                }
            }

            if (!hasCapacity) {
                console.warn(`Insufficient Position Capacity for ${hedgeDirection} ${btcSize} BTC`);
                return undefined;
            }

            if (weAreBuyingBtc && fundingRate < BTC_ONLY_CONFIG.MIN_HOURLY_FUNDING_RATE) {
                console.warn(`High Funding Rate: ${fundingRate}. Rejecting Quote.`);
                return undefined;
            }

            // 6. Calculate Reference Price with Actual Size
            let referencePrice = 0;
            if (weAreBuyingBtc) {
                referencePrice = this.hyperliquidService.getHedgePrice('bid', btcSize);
            } else {
                referencePrice = this.hyperliquidService.getHedgePrice('ask', btcSize);
            }

            // 7. Apply Spread
            const spread = BTC_ONLY_CONFIG.TARGET_SPREAD_BIPS / 10000;

            let finalPrice = 0;
            let amountOut = 0;

            if (weAreBuyingBtc) {
                finalPrice = referencePrice * (1 - spread);
                amountOut = btcSize * finalPrice;
            } else {
                finalPrice = referencePrice * (1 + spread);
                amountOut = amountInFloat / finalPrice;
            }

            // 8. Return Quote
            const amountOutRaw = Math.floor(amountOut * Math.pow(10, decimalsOut)).toString();

            this.logger.logTrade({
                type: 'QUOTE_GENERATED',
                direction: weAreBuyingBtc ? 'buy' : 'sell',
                amountBtc: weAreBuyingBtc ? amountOut : btcSize,
                amountUsdt: weAreBuyingBtc ? amountInFloat : amountOut * finalPrice,
                quotedPrice: finalPrice
            });

            return {
                amount_out: amountOutRaw
            };

        } catch (e) {
            console.error("Failed to quote:", e);
            return undefined;
        }
    }
}
