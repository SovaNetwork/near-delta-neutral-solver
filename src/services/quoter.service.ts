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

export interface QuoteResult {
    amount_out: string;
    btcSize: number;
    weAreBuyingBtc: boolean;
    btcTokenId: string;
    usdTokenId: string;
    btcDecimals: number;
    usdDecimals: number;
}

export class QuoterService {
    constructor(
        private inventoryManager: InventoryStateService,
        private hyperliquidService: HyperliquidService,
        private nearService: NearService,
        private logger: LoggerService
    ) { }

    getQuote(request: QuoteRequest): QuoteResult | undefined {
        // Early out if orderbook is stale (avoid exceptions in hot path)
        if (!this.hyperliquidService.isOrderbookFresh()) {
            return undefined;
        }

        // 1. Validate Assets - use O(1) Map lookups
        const btcCfg = BTC_ONLY_CONFIG.getBtcTokenConfig(request.token_in) 
            || BTC_ONLY_CONFIG.getBtcTokenConfig(request.token_out);
        const usdCfg = BTC_ONLY_CONFIG.getUsdTokenConfig(request.token_in)
            || BTC_ONLY_CONFIG.getUsdTokenConfig(request.token_out);
        
        if (!btcCfg || !usdCfg) {
            return undefined;
        }

        const isBtcIn = BTC_ONLY_CONFIG.isBtcToken(request.token_in);

        // 2. Determine if we are Buying or Selling BTC (from user's perspective, we receive BTC)
        const weAreBuyingBtc = isBtcIn;
        const btcTokenId = isBtcIn ? request.token_in : request.token_out;
        const usdTokenId = isBtcIn ? request.token_out : request.token_in;

        // 3. Use pre-computed pow10 for fast decimal conversion
        const btcPow10 = btcCfg.pow10;
        const usdPow10 = usdCfg.pow10;
        const pow10In = isBtcIn ? btcPow10 : usdPow10;
        const pow10Out = isBtcIn ? usdPow10 : btcPow10;

        const amountInFloat = +request.amount_in / pow10In;

        // 4. Size Estimation with early validation
        let btcSize = 0;

        if (weAreBuyingBtc) {
            btcSize = amountInFloat;
        } else {
            const probePrice = this.hyperliquidService.getHedgePrice('ask', 0.001);
            if (!probePrice) return undefined;
            
            const estimatedSize = amountInFloat / probePrice;
            
            // Early size validation before querying full depth
            if (estimatedSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC || 
                estimatedSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
                return undefined;
            }
            
            const refinedPrice = this.hyperliquidService.getHedgePrice('ask', estimatedSize);
            if (!refinedPrice) return undefined;
            
            btcSize = amountInFloat / refinedPrice;
        }

        // Size Validation
        if (btcSize < BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC || 
            btcSize > BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC) {
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
            return undefined;
        }

        // Reject if funding is too negative (worse than threshold)
        if (weAreBuyingBtc && fundingRate < BTC_ONLY_CONFIG.MAX_NEGATIVE_FUNDING_RATE) {
            return undefined;
        }

        // 6. Calculate Reference Price with Actual Size
        const referencePrice = this.hyperliquidService.getHedgePrice(
            weAreBuyingBtc ? 'bid' : 'ask', 
            btcSize
        );
        if (!referencePrice) return undefined;

        // 7. Apply Spread
        const spread = BTC_ONLY_CONFIG.TARGET_SPREAD_BIPS / 10000;

        let finalPrice: number;
        let amountOut: number;

        if (weAreBuyingBtc) {
            finalPrice = referencePrice * (1 - spread);
            amountOut = btcSize * finalPrice;
        } else {
            finalPrice = referencePrice * (1 + spread);
            amountOut = amountInFloat / finalPrice;
        }

        // 8. Return Quote with metadata for caller
        const amountOutRaw = Math.floor(amountOut * pow10Out).toString();

        return {
            amount_out: amountOutRaw,
            btcSize,
            weAreBuyingBtc,
            btcTokenId,
            usdTokenId,
            btcDecimals: btcCfg.decimals,
            usdDecimals: usdCfg.decimals,
        };
    }
}
