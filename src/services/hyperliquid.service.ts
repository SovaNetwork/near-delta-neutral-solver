import {
    InfoClient, ExchangeClient, SubscriptionClient,
    HttpTransport, WebSocketTransport
} from '@nktkas/hyperliquid';
import { Wallet } from 'ethers';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
dotenv.config();

interface ClearinghouseSnapshot {
    margin: number;
    position: number;
    timestamp: number;
}

export class HyperliquidService {
    private infoClient: InfoClient;
    private exchangeClient: ExchangeClient | undefined;
    private subClient: SubscriptionClient | null = null;

    private wallet: Wallet | undefined;
    private assetToIndexMap: Map<string, number> = new Map();
    private l2Book: { levels: [Array<{px: string, sz: string}>, Array<{px: string, sz: string}>] } | null = null;
    private lastBookUpdateMs: number = 0;

    private isMainnet: boolean;
    private coin: string = 'BTC';
    private assetIndex: number = -1;

    private clearinghouseCache: ClearinghouseSnapshot | null = null;
    private fundingRateCache: { rate: number, timestamp: number } | null = null;
    private readonly CACHE_TTL_MS = 10000;
    private readonly FUNDING_CACHE_TTL_MS = 60000;

    // Orderbook subscription health monitoring
    private readonly ORDERBOOK_HEALTH_CHECK_INTERVAL_MS = 10000; // Check every 10s
    private readonly ORDERBOOK_MAX_IDLE_MS = 30000; // Resubscribe if no updates for 30s
    private orderbookHealthInterval: NodeJS.Timeout | null = null;
    private isResubscribing: boolean = false;

    constructor() {
        this.isMainnet = process.env.HYPERLIQUID_MAINNET !== 'false';
        const isTestnet = !this.isMainnet;

        if (!global.WebSocket) {
            (global as any).WebSocket = WebSocket;
        }

        const httpTransport = new HttpTransport({ isTestnet });
        this.infoClient = new InfoClient({ transport: httpTransport });

        const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
        if (privateKey) {
            this.wallet = new Wallet(privateKey);
            this.exchangeClient = new ExchangeClient({
                transport: httpTransport,
                wallet: this.wallet,
            });
        } else {
            console.warn("No Hyperliquid Private Key found. Execution disabled.");
        }
    }

    private createSubscriptionClient(): SubscriptionClient {
        const isTestnet = !this.isMainnet;
        const wsTransport = new WebSocketTransport({ isTestnet });
        return new SubscriptionClient({ transport: wsTransport });
    }

    async init() {
        // 1. Fetch Meta with retry logic
        let retries = 3;
        let meta: any;
        while (retries > 0) {
            try {
                meta = await this.infoClient.meta();
                break;
            } catch (e: any) {
                retries--;
                if (retries === 0) throw e;
                console.warn(`Hyperliquid API error, retrying... (${retries} left)`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        const runiverse = meta.universe;
        for (let i = 0; i < runiverse.length; i++) {
            const assetParam = runiverse[i];
            if (!assetParam) continue;
            this.assetToIndexMap.set(assetParam.name, i);
        }

        const idx = this.assetToIndexMap.get(this.coin);
        if (idx === undefined) throw new Error(`Asset ${this.coin} not found on Hyperliquid`);
        this.assetIndex = idx;
        console.log(`Hyperliquid Connected. ${this.coin} Asset Index: ${this.assetIndex}`);

        // 2. Subscribe to L2 Book and wait for first data
        await this.subscribeToOrderbook();

        // 3. Start health monitoring
        this.startOrderbookHealthCheck();
    }

    private async subscribeToOrderbook(): Promise<void> {
        // Create fresh subscription client
        this.subClient = this.createSubscriptionClient();

        await new Promise<void>((resolve) => {
            let initialDataReceived = false;
            this.subClient!.l2Book({ coin: this.coin }, (data: any) => {
                if (data && data.levels) {
                    this.l2Book = { levels: data.levels };
                    this.lastBookUpdateMs = Date.now();
                }

                if (!initialDataReceived) {
                    initialDataReceived = true;
                    resolve();
                }
            });
        });
        console.log(`Subscribed to L2 Book for ${this.coin}`);
    }

    private startOrderbookHealthCheck(): void {
        if (this.orderbookHealthInterval) {
            clearInterval(this.orderbookHealthInterval);
        }

        this.orderbookHealthInterval = setInterval(() => {
            this.checkOrderbookHealth();
        }, this.ORDERBOOK_HEALTH_CHECK_INTERVAL_MS);

        console.log(`Orderbook health check started (every ${this.ORDERBOOK_HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
    }

    private async checkOrderbookHealth(): Promise<void> {
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastBookUpdateMs;

        if (timeSinceLastUpdate > this.ORDERBOOK_MAX_IDLE_MS) {
            console.warn(`[Hyperliquid] Orderbook stale for ${(timeSinceLastUpdate / 1000).toFixed(1)}s - resubscribing...`);
            await this.resubscribeToOrderbook();
        }
    }

    private async resubscribeToOrderbook(): Promise<void> {
        if (this.isResubscribing) {
            console.log('[Hyperliquid] Resubscription already in progress, skipping...');
            return;
        }

        this.isResubscribing = true;

        try {
            // Close existing subscription client if it exists
            if (this.subClient) {
                try {
                    // The library may not have a close method, so we just null it
                    this.subClient = null;
                } catch (e) {
                    // Ignore close errors
                }
            }

            // Small delay before reconnecting
            await new Promise(r => setTimeout(r, 1000));

            // Resubscribe
            await this.subscribeToOrderbook();
            console.log('[Hyperliquid] Successfully resubscribed to orderbook');
        } catch (e) {
            console.error('[Hyperliquid] Failed to resubscribe to orderbook:', e);
            // Will retry on next health check
        } finally {
            this.isResubscribing = false;
        }
    }

    stopHealthCheck(): void {
        if (this.orderbookHealthInterval) {
            clearInterval(this.orderbookHealthInterval);
            this.orderbookHealthInterval = null;
            console.log('Orderbook health check stopped');
        }
    }

    getHedgePrice(side: 'bid' | 'ask', size: number): number {
        if (!this.l2Book || !this.l2Book.levels) {
            throw new Error("Orderbook not yet available");
        }

        const bookAge = Date.now() - this.lastBookUpdateMs;
        if (bookAge > BTC_ONLY_CONFIG.MAX_ORDERBOOK_AGE_MS) {
            throw new Error(`Orderbook stale (${bookAge}ms old, max ${BTC_ONLY_CONFIG.MAX_ORDERBOOK_AGE_MS}ms)`);
        }

        const levels = side === 'bid' ? this.l2Book.levels[0] : this.l2Book.levels[1];

        let value = 0;
        let sizeRemaining = size;

        for (const level of levels) {
            const px = parseFloat(level.px);
            const sz = parseFloat(level.sz);

            const take = Math.min(sz, sizeRemaining);
            value += take * px;
            sizeRemaining -= take;

            if (sizeRemaining <= 0) break;
        }

        if (sizeRemaining > 0.000001) {
            throw new Error(`Insufficient liquidity to quote ${size} ${this.coin}`);
        }

        return value / size;
    }

    isOrderbookFresh(): boolean {
        return this.l2Book !== null && (Date.now() - this.lastBookUpdateMs) <= BTC_ONLY_CONFIG.MAX_ORDERBOOK_AGE_MS;
    }

    async refreshClearinghouseState(): Promise<ClearinghouseSnapshot | null> {
        if (!this.wallet) return null;

        try {
            const userState = await this.infoClient.clearinghouseState({ user: this.wallet.address });
            const marginSummary = userState.marginSummary;

            const accountValue = parseFloat(marginSummary.accountValue);
            const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed);
            const margin = accountValue - totalMarginUsed;

            const positions = userState.assetPositions;
            const btcPos = positions.find((p: any) => p.position.coin === this.coin);
            const position = btcPos ? parseFloat(btcPos.position.szi) : 0;

            this.clearinghouseCache = { margin, position, timestamp: Date.now() };
            return this.clearinghouseCache;
        } catch (e) {
            console.error("[Hyperliquid] Failed to fetch clearinghouse state:", e);
            return null;
        }
    }

    async getAvailableMargin(): Promise<number> {
        if (!this.wallet) return 0;

        const now = Date.now();
        if (this.clearinghouseCache && (now - this.clearinghouseCache.timestamp) < this.CACHE_TTL_MS) {
            return this.clearinghouseCache.margin;
        }

        const snapshot = await this.refreshClearinghouseState();
        return snapshot?.margin ?? 0;
    }

    async getBtcPosition(): Promise<number> {
        if (!this.wallet) return 0;

        const now = Date.now();
        if (this.clearinghouseCache && (now - this.clearinghouseCache.timestamp) < this.CACHE_TTL_MS) {
            return this.clearinghouseCache.position;
        }

        const snapshot = await this.refreshClearinghouseState();
        return snapshot?.position ?? 0;
    }

    invalidateClearinghouseCache(): void {
        this.clearinghouseCache = null;
    }

    async getFundingRate(): Promise<number> {
        // Check cache first (funding rate changes slowly, hot path optimization)
        const now = Date.now();
        if (this.fundingRateCache && (now - this.fundingRateCache.timestamp) < this.FUNDING_CACHE_TTL_MS) {
            return this.fundingRateCache.rate;
        }

        // Fetch metaAndAssetCtxs to get funding
        const metaAndCtxs = await this.infoClient.metaAndAssetCtxs();
        const ctxs = metaAndCtxs[1]; // AssetCtx[]
        const assetCtx = ctxs[this.assetIndex];
        const rate = assetCtx ? parseFloat(assetCtx.funding) : 0;

        // Cache the result
        this.fundingRateCache = { rate, timestamp: now };
        return rate;
    }

    getOrderbookSummary(): { bestBid: number; bestAsk: number; midPrice: number; spread: number; spreadBps: number } | null {
        try {
            if (!this.l2Book || !this.l2Book.levels) {
                return null;
            }

            const bids = this.l2Book.levels[0];
            const asks = this.l2Book.levels[1];

            if (!bids || !asks || bids.length === 0 || asks.length === 0) {
                return null;
            }

            const firstBid = bids[0];
            const firstAsk = asks[0];
            if (!firstBid || !firstAsk) {
                return null;
            }

            const bestBid = parseFloat(firstBid.px);
            const bestAsk = parseFloat(firstAsk.px);
            const midPrice = (bestBid + bestAsk) / 2;
            const spread = bestAsk - bestBid;
            const spreadBps = (spread / midPrice) * 10000;

            return { bestBid, bestAsk, midPrice, spread, spreadBps };
        } catch (e) {
            return null;
        }
    }

    async executeHedge(direction: 'short' | 'long', size: number) {
        if (!this.exchangeClient) throw new Error("Exchange client not initialized");

        const isBuy = direction === 'long';
        const currentPrice = this.getHedgePrice(isBuy ? 'ask' : 'bid', size);
        
        const slippageBps = BTC_ONLY_CONFIG.HEDGE_SLIPPAGE_BPS;
        const limitPx = isBuy
            ? currentPrice * (1 + slippageBps / 10000)
            : currentPrice * (1 - slippageBps / 10000);
        const price = Number(limitPx.toFixed(1));

        console.log(`Executing Hedge: ${direction} ${size} BTC @ ~${price} (slippage: ${slippageBps}bps)`);

        const result = await this.exchangeClient.order({
            orders: [{
                a: this.assetIndex,
                b: isBuy,
                p: price.toString(),
                s: size.toString(),
                r: false,
                t: { limit: { tif: 'Ioc' } }
            }],
            grouping: 'na'
        });

        this.invalidateClearinghouseCache();

        return result;
    }

    async checkPositionCapacity(direction: 'short' | 'long', sizeBtc: number): Promise<boolean> {
        // Current Position: +1.0 (Long) or -1.0 (Short).
        // Max Inventory: 5.0 (Config).

        try {
            const currentPos = await this.getBtcPosition();

            let projectedPos = currentPos;
            if (direction === 'short') {
                projectedPos -= sizeBtc;
            } else {
                projectedPos += sizeBtc;
            }

            // Check if projected position assumes more risk than allowed
            if (Math.abs(projectedPos) > BTC_ONLY_CONFIG.MAX_BTC_INVENTORY) {
                console.warn(`[RISK] Trade size ${sizeBtc} would exceed max inventory. Projected: ${projectedPos}, Max: ${BTC_ONLY_CONFIG.MAX_BTC_INVENTORY}`);
                return false;
            }
            return true;
        } catch (e) {
            console.error("Failed to check position capacity", e);
            return false;
        }
    }
}
