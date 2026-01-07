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
            // 1. Validate Assets - accept any supported BTC token paired with USDT
            const isBtcIn = BTC_ONLY_CONFIG.isBtcToken(request.token_in);
            const isUsdtIn = request.token_in === BTC_ONLY_CONFIG.USDT_TOKEN_ID;
            const isBtcOut = BTC_ONLY_CONFIG.isBtcToken(request.token_out);
            const isUsdtOut = request.token_out === BTC_ONLY_CONFIG.USDT_TOKEN_ID;

            if (!((isBtcIn && isUsdtOut) || (isUsdtIn && isBtcOut))) {
                return undefined;
            }

            // 2. Determine if we are Buying or Selling BTC (from user's perspective, we receive BTC)
            const weAreBuyingBtc = isBtcIn;
            const btcTokenId = isBtcIn ? request.token_in : request.token_out;

            // 3. Calculate Price using config decimals
            const btcDecimals = BTC_ONLY_CONFIG.getBtcDecimals(btcTokenId);
            const decimalsIn = isBtcIn ? btcDecimals : BTC_ONLY_CONFIG.USDT_DECIMALS;
            const decimalsOut = isBtcOut ? btcDecimals : BTC_ONLY_CONFIG.USDT_DECIMALS;

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

            // Calculate correct amounts for logging:
            // weAreBuyingBtc = user sends BTC, we send USDT
            //   -> amountBtc = btcSize (what user sends), amountUsdt = amountOut (what we send)
            // !weAreBuyingBtc = user sends USDT, we send BTC  
            //   -> amountBtc = amountOut (what we send), amountUsdt = amountInFloat (what user sends)
            const logAmountBtc = weAreBuyingBtc ? btcSize : amountOut;
            const logAmountUsdt = weAreBuyingBtc ? amountOut : amountInFloat;

            this.logger.logTrade({
                type: 'QUOTE_GENERATED',
                direction: weAreBuyingBtc ? 'buy' : 'sell',
                amountBtc: logAmountBtc,
                amountUsdt: logAmountUsdt,
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
