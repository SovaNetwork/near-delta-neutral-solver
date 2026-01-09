import { InventoryStateService } from './inventory-manager.service';
import { HyperliquidService } from './hyperliquid.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
import { NearService } from './near.service';
import { LoggerService } from './logger.service';

export interface QuoteRequest {
    token_in: string;
    token_out: string;
    amount_in?: string;   // For exact_amount_in quotes
    amount_out?: string;  // For exact_amount_out quotes
}

export interface QuoteResult {
    amount_out?: string;  // Set for exact_amount_in quotes
    amount_in?: string;   // Set for exact_amount_out quotes
    btcSize: number;
    weAreBuyingBtc: boolean;
    btcTokenId: string;
    usdTokenId: string;
    btcDecimals: number;
    usdDecimals: number;
    isExactOut: boolean;  // true if this was an exact_amount_out quote
}

export type QuoteRejectionReason =
    | 'orderbook_stale'
    | 'invalid_token_pair'
    | 'size_out_of_bounds'
    | 'insufficient_liquidity'
    | 'direction_not_allowed'
    | 'position_capacity_exceeded'
    | 'funding_rate_too_negative'
    | 'no_reference_price';

export class QuoterService {
    // Rejection counters for debugging (reset periodically)
    private rejectionCounts: Map<QuoteRejectionReason, number> = new Map();
    private lastRejectionReason: QuoteRejectionReason | null = null;
    private quotesReceived: number = 0;
    private quotesGenerated: number = 0;

    constructor(
        private inventoryManager: InventoryStateService,
        private hyperliquidService: HyperliquidService,
        private nearService: NearService,
        private logger: LoggerService
    ) { }

    private reject(reason: QuoteRejectionReason): undefined {
        this.lastRejectionReason = reason;
        this.rejectionCounts.set(reason, (this.rejectionCounts.get(reason) || 0) + 1);
        return undefined;
    }

    getStats(): { received: number; generated: number; rejections: Record<string, number> } {
        const rejections: Record<string, number> = {};
        for (const [reason, count] of this.rejectionCounts) {
            rejections[reason] = count;
        }
        return {
            received: this.quotesReceived,
            generated: this.quotesGenerated,
            rejections
        };
    }

    resetStats(): void {
        this.quotesReceived = 0;
        this.quotesGenerated = 0;
        this.rejectionCounts.clear();
    }

    getQuote(request: QuoteRequest): QuoteResult | undefined {
        this.quotesReceived++;

        // Early out if orderbook is stale (avoid exceptions in hot path)
        if (!this.hyperliquidService.isOrderbookFresh()) {
            return this.reject('orderbook_stale');
        }

        // Determine if this is an exact_amount_out quote
        const isExactOut = !request.amount_in && !!request.amount_out;

        // 1. Validate Assets - use O(1) Map lookups
        const btcCfg = BTC_ONLY_CONFIG.getBtcTokenConfig(request.token_in)
            || BTC_ONLY_CONFIG.getBtcTokenConfig(request.token_out);
        const usdCfg = BTC_ONLY_CONFIG.getUsdTokenConfig(request.token_in)
            || BTC_ONLY_CONFIG.getUsdTokenConfig(request.token_out);

        if (!btcCfg || !usdCfg) {
            return this.reject('invalid_token_pair');
        }

        const isBtcIn = BTC_ONLY_CONFIG.isBtcToken(request.token_in);
        const isBtcOut = BTC_ONLY_CONFIG.isBtcToken(request.token_out);

        // 2. Determine if we are Buying or Selling BTC (from solver's perspective)
        // weAreBuyingBtc = true when user sends us BTC (we receive BTC, user gets USD)
        const weAreBuyingBtc = isBtcIn;
        const btcTokenId = isBtcIn ? request.token_in : request.token_out;
        const usdTokenId = isBtcIn ? request.token_out : request.token_in;

        // 3. Use pre-computed pow10 for fast decimal conversion
        const btcPow10 = btcCfg.pow10;
        const usdPow10 = usdCfg.pow10;

        // 4. Calculate BTC size based on quote type
        let btcSize = 0;
        let referencePrice: number | null = null;

        if (isExactOut) {
            // exact_amount_out: user wants exactly X of token_out
            const amountOutFloat = +request.amount_out! / (isBtcOut ? btcPow10 : usdPow10);

            if (isBtcOut) {
                // User wants exact BTC out (we sell BTC to them, hedge by going long)
                btcSize = amountOutFloat;
                referencePrice = this.hyperliquidService.getHedgePrice('ask', btcSize);
            } else {
                // User wants exact USD out (we sell USD to them, receive BTC, hedge by shorting)
                // Need to calculate how much BTC they need to send for this USD amount
                const probePrice = this.hyperliquidService.getHedgePrice('bid', 0.001);
                if (!probePrice) return this.reject('insufficient_liquidity');

                const estimatedSize = amountOutFloat / probePrice;
                if (estimatedSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC ||
                    estimatedSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
                    return this.reject('size_out_of_bounds');
                }

                referencePrice = this.hyperliquidService.getHedgePrice('bid', estimatedSize);
                if (!referencePrice) return this.reject('insufficient_liquidity');

                btcSize = amountOutFloat / referencePrice;
            }
        } else {
            // exact_amount_in: user sends exactly X of token_in
            const amountInFloat = +request.amount_in! / (isBtcIn ? btcPow10 : usdPow10);

            if (isBtcIn) {
                // User sends exact BTC in (we receive BTC, hedge by shorting)
                btcSize = amountInFloat;
                referencePrice = this.hyperliquidService.getHedgePrice('bid', btcSize);
            } else {
                // User sends exact USD in (we receive USD, send BTC, hedge by going long)
                const probePrice = this.hyperliquidService.getHedgePrice('ask', 0.001);
                if (!probePrice) return this.reject('insufficient_liquidity');

                const estimatedSize = amountInFloat / probePrice;
                if (estimatedSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC ||
                    estimatedSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
                    return this.reject('size_out_of_bounds');
                }

                referencePrice = this.hyperliquidService.getHedgePrice('ask', estimatedSize);
                if (!referencePrice) return this.reject('insufficient_liquidity');

                btcSize = amountInFloat / referencePrice;
            }
        }

        if (!referencePrice) return this.reject('no_reference_price');

        // Size Validation
        if (btcSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC ||
            btcSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
            return this.reject('size_out_of_bounds');
        }

        // 5. All checks are now synchronous - no network I/O
        const hedgeDirection = weAreBuyingBtc ? 'short' : 'long';

        const direction = this.inventoryManager.getQuoteDirection();
        const hasCapacity = this.inventoryManager.checkPositionCapacity(hedgeDirection, btcSize);
        const fundingRate = weAreBuyingBtc ? this.inventoryManager.getFundingRate() : 0;

        // Check inventory direction
        if (weAreBuyingBtc) {
            if (direction !== 'BUY_BTC_ONLY' && direction !== 'BOTH') {
                return this.reject('direction_not_allowed');
            }
        } else {
            if (direction !== 'SELL_BTC_ONLY' && direction !== 'BOTH') {
                return this.reject('direction_not_allowed');
            }
        }

        if (!hasCapacity) {
            return this.reject('position_capacity_exceeded');
        }

        // Reject if funding is too negative (worse than threshold)
        if (weAreBuyingBtc && fundingRate < BTC_ONLY_CONFIG.MAX_NEGATIVE_FUNDING_RATE) {
            return this.reject('funding_rate_too_negative');
        }

        // 6. Apply Spread
        const spread = BTC_ONLY_CONFIG.TARGET_SPREAD_BIPS / 10000;

        // Calculate the missing amount (either amount_in or amount_out)
        if (isExactOut) {
            // exact_amount_out: we know the output, calculate input
            const amountOutFloat = +request.amount_out! / (isBtcOut ? btcPow10 : usdPow10);
            let amountIn: number;

            if (weAreBuyingBtc) {
                // User sends BTC, gets exact USD out
                // finalPrice = referencePrice * (1 - spread) means less USD per BTC for user
                const finalPrice = referencePrice * (1 - spread);
                amountIn = amountOutFloat / finalPrice; // BTC needed
            } else {
                // User sends USD, gets exact BTC out  
                // finalPrice = referencePrice * (1 + spread) means more USD per BTC for user
                const finalPrice = referencePrice * (1 + spread);
                amountIn = amountOutFloat * finalPrice; // USD needed
            }

            // Round UP for amount_in (user pays more to ensure we're covered)
            const pow10In = isBtcIn ? btcPow10 : usdPow10;
            const amountInRaw = Math.ceil(amountIn * pow10In).toString();

            this.quotesGenerated++;
            return {
                amount_in: amountInRaw,
                btcSize,
                weAreBuyingBtc,
                btcTokenId,
                usdTokenId,
                btcDecimals: btcCfg.decimals,
                usdDecimals: usdCfg.decimals,
                isExactOut: true,
            };
        } else {
            // exact_amount_in: we know the input, calculate output
            const amountInFloat = +request.amount_in! / (isBtcIn ? btcPow10 : usdPow10);
            let amountOut: number;

            if (weAreBuyingBtc) {
                // User sends BTC, gets USD out
                const finalPrice = referencePrice * (1 - spread);
                amountOut = amountInFloat * finalPrice; // USD out
            } else {
                // User sends USD, gets BTC out
                const finalPrice = referencePrice * (1 + spread);
                amountOut = amountInFloat / finalPrice; // BTC out
            }

            // Round DOWN for amount_out (user gets slightly less)
            const pow10Out = isBtcOut ? btcPow10 : usdPow10;
            const amountOutRaw = Math.floor(amountOut * pow10Out).toString();

            this.quotesGenerated++;
            return {
                amount_out: amountOutRaw,
                btcSize,
                weAreBuyingBtc,
                btcTokenId,
                usdTokenId,
                btcDecimals: btcCfg.decimals,
                usdDecimals: usdCfg.decimals,
                isExactOut: false,
            };
        }
    }
}
