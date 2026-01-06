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

    async getQuote(request: QuoteRequest) {
        try {
            // 1. Validate Assets
            const isBtcIn = request.token_in === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
            const isUsdtIn = request.token_in === BTC_ONLY_CONFIG.USDT_TOKEN_ID;
            const isBtcOut = request.token_out === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
            const isUsdtOut = request.token_out === BTC_ONLY_CONFIG.USDT_TOKEN_ID;

            if (!((isBtcIn && isUsdtOut) || (isUsdtIn && isBtcOut))) {
                return undefined; // Not a BTC/USDC pair
            }

            // 2. Check Inventory Direction
            const direction = await this.inventoryManager.getQuoteDirection();

            // 3. Determine if we are Buying or Selling BTC
            // If BTC In -> User is Selling BTC -> We are Buying BTC.
            const weAreBuyingBtc = isBtcIn;

            if (weAreBuyingBtc) {
                if (direction !== 'BUY_BTC_ONLY' && direction !== 'BOTH') {
                    console.log("Reject: Inventory does not allow Buying BTC.");
                    return undefined;
                }
            } else {
                // We are Selling BTC
                if (direction !== 'SELL_BTC_ONLY' && direction !== 'BOTH') {
                    console.log("Reject: Inventory does not allow Selling BTC.");
                    return undefined;
                }
            }

            // 4. Calculate Price
            // Amount In is raw. Need decimals.
            // BTC: 8, USDC: 6.
            const decimalsIn = isBtcIn ? 8 : 6;
            const decimalsOut = isBtcOut ? 8 : 6;

            const amountInFloat = parseFloat(request.amount_in) / Math.pow(10, decimalsIn);

            // 5. Validation and Size Estimation
            let btcSize = 0;

            if (weAreBuyingBtc) {
                // User Sells BTC (We Buy BTC). Amount In is BTC.
                btcSize = amountInFloat;
            } else {
                // User Buys BTC (We Sell BTC). Amount In is USDT.
                // Iterative Refinement for Accuracy
                // 1. Initial Probe
                const probePrice = this.hyperliquidService.getHedgePrice('ask', 0.001);
                let estimatedSize = amountInFloat / probePrice;

                // 2. Refine with Estimated Size
                const refinedPrice = this.hyperliquidService.getHedgePrice('ask', estimatedSize);
                btcSize = amountInFloat / refinedPrice;
            }

            // Size Validation
            if (btcSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC) {
                console.warn(`Quote Request too small: ${btcSize} BTC < MIN ${BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC}`);
                return undefined;
            }
            if (btcSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
                console.warn(`Quote Request too large: ${btcSize} BTC > MAX ${BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC}`);
                return undefined;
            }

            // Position Capacity Check & Funding Rate Check (parallel for speed)
            const hedgeDirection = weAreBuyingBtc ? 'short' : 'long';

            // Run checks in parallel when buying BTC
            const [hasCapacity, fundingRate] = await Promise.all([
                this.hyperliquidService.checkPositionCapacity(hedgeDirection, btcSize),
                weAreBuyingBtc ? this.hyperliquidService.getFundingRate() : Promise.resolve(0)
            ]);

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
                // We Buy. User Sell.
                finalPrice = referencePrice * (1 - spread);
                amountOut = btcSize * finalPrice;
            } else {
                // We Sell. User Buy.
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
