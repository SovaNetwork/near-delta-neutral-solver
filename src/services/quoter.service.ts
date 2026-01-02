import { InventoryStateService } from './inventory-manager.service';
import { HyperliquidService } from './hyperliquid.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
import { NearService } from './near.service';

export interface QuoteRequest {
    token_in: string;
    token_out: string;
    amount_in: string; // Readable or BigInt string? Assuming readable for simplicity or handling formatting.
    // Usually requests come with raw BigInts. I'll assume standard string.
}

export class QuoterService {
    constructor(
        private inventoryManager: InventoryStateService,
        private hyperliquidService: HyperliquidService,
        private nearService: NearService
    ) { }

    async getQuote(request: QuoteRequest) {
        // 1. Validate Assets
        const isBtcIn = request.token_in === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
        const isUsdcIn = request.token_in === BTC_ONLY_CONFIG.USDC_TOKEN_ID;
        const isBtcOut = request.token_out === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
        const isUsdcOut = request.token_out === BTC_ONLY_CONFIG.USDC_TOKEN_ID;

        if (!((isBtcIn && isUsdcOut) || (isUsdcIn && isBtcOut))) {
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

        try {
            // size for HL is always in BTC?
            const btcSize = weAreBuyingBtc ? amountInFloat : 0; // If checking price for BTC_IN, size is amountIn.
            // If checking price for USDC_IN (User Buys BTC), we need to estimate BTC size?
            // Ask price depends on size.
            // For User Buys BTC (USDC In), we approximate size = AmountUSDC / CurrentPrice.
            // 5a. Check Funding Rate Risk (If opening a position)
            // We are shorting if we Buy BTC.
            if (weAreBuyingBtc) {
                const fundingRate = await this.hyperliquidService.getFundingRate();
                // Funding is hourly? Config is MIN_HOURLY.
                // If funding is negative (Shorts pay Longs).
                if (fundingRate < BTC_ONLY_CONFIG.MIN_HOURLY_FUNDING_RATE) {
                    console.warn(`High Funding Rate: ${fundingRate}. Rejecting Quote.`);
                    return undefined;
                }
            }

            // let's get a reference price first.

            let referencePrice = 0;
            if (!weAreBuyingBtc) {
                // We are selling BTC. We need to buy it back on HL (Long) to close short? 
                // Wait. Spec says: "Unwind: Offer to SELL Bitcoin back to users, closing the short position."
                // "Hedge Unwind... Market Buy (Close Short) on Hyperliquid."
                // So we check HL Ask Price.
                const approxPrice = this.hyperliquidService.getHedgePrice('ask', 0.001); // Probe
                const estimatedBtcOut = amountInFloat / approxPrice;
                referencePrice = this.hyperliquidService.getHedgePrice('ask', estimatedBtcOut);
            } else {
                // We are buying BTC. We Short on HL (Bid).
                referencePrice = this.hyperliquidService.getHedgePrice('bid', amountInFloat);
            }

            // 5. Apply Spread
            // Spread Bips e.g. 200 => 2%.
            const spread = BTC_ONLY_CONFIG.TARGET_SPREAD_BIPS / 10000;

            let finalPrice = 0;
            let amountOut = 0;

            if (weAreBuyingBtc) {
                // We Buy. User Sell.
                // Quote Price = HL Bid * (1 - Spread)
                finalPrice = referencePrice * (1 - spread);
                // We pay USDC. Amount Out = BTC * Price.
                amountOut = amountInFloat * finalPrice;
            } else {
                // We Sell. User Buy.
                // Quote Price = HL Ask * (1 + Spread).
                // User pays USDC. We give BTC.
                // Price is USDC per BTC.
                // Amount Out (BTC) = Amount In (USDC) / Price.
                finalPrice = referencePrice * (1 + spread);
                amountOut = amountInFloat / finalPrice;
            }

            // 6. Return Quote
            // Need to convert amountOut back to integer string.
            const amountOutRaw = Math.floor(amountOut * Math.pow(10, decimalsOut)).toString();

            return {
                amount_out: amountOutRaw,
                // In a real solver, we would sign the intent here using nearService.
                // Adding a placeholder for signature.
                signature: 'mock_signature'
            };

        } catch (e) {
            console.error("Failed to quote:", e);
            return undefined;
        }
    }
}
