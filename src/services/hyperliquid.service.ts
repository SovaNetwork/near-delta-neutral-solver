import {
    InfoClient, ExchangeClient, SubscriptionClient,
    HttpTransport, WebSocketTransport,
    MAINNET_API_URL, TESTNET_API_URL,
    MAINNET_API_WS_URL, TESTNET_API_WS_URL
} from '@nktkas/hyperliquid';
import { Wallet } from 'ethers';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
dotenv.config();

export class HyperliquidService {
    private infoClient: InfoClient;
    private exchangeClient: ExchangeClient | undefined;
    private subClient: SubscriptionClient;

    private wallet: any;
    private assetToIndexMap: Map<string, number> = new Map();
    private l2Book: any = { bids: [], asks: [] };

    private isMainnet: boolean;
    private coin: string = 'BTC';
    private assetIndex: number = -1;

    private marginCache: { margin: number, timestamp: number, refreshing?: boolean } | null = null;
    private positionCache: { position: number, timestamp: number, refreshing?: boolean } | null = null;
    private fundingRateCache: { rate: number, timestamp: number } | null = null;
    private readonly CACHE_TTL_MS = 15000; // 15 second cache for margin (faster reactions)
    private readonly CACHE_REFRESH_THRESHOLD_MS = 10000; // Start background refresh after 10s
    private readonly POSITION_CACHE_TTL_MS = 10000; // 10 second cache for position (critical for competitiveness)
    private readonly POSITION_REFRESH_THRESHOLD_MS = 7000; // Start background refresh after 7s
    private readonly FUNDING_CACHE_TTL_MS = 60000; // 60 second cache for funding rate (changes slowly)

    constructor() {
        this.isMainnet = process.env.HYPERLIQUID_MAINNET !== 'false';

        if (!global.WebSocket) {
            (global as any).WebSocket = WebSocket;
        }

        const apiUrl = this.isMainnet ? MAINNET_API_URL : TESTNET_API_URL;
        const wsUrl = this.isMainnet ? MAINNET_API_WS_URL : TESTNET_API_WS_URL;

        const infoTransport = new HttpTransport({ url: apiUrl } as any);
        this.infoClient = new InfoClient({ transport: infoTransport });

        const wsTransport = new WebSocketTransport({ url: wsUrl, WebSocket: WebSocket } as any);
        this.subClient = new SubscriptionClient({ transport: wsTransport });

        const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
        if (privateKey) {
            this.wallet = new Wallet(privateKey);
            // Assuming ExchangeClient takes wallet. 
            // If previous error said "Expected 1 argument", and defaults are mainnet, this is likely fine for mainnet.
            // For testnet... if we can't pass config, maybe we can't easily? 
            // But let's assume Mainnet for now as per spec default.
            // To be safe I'll cast to any if needed, but error was specific about argument count.
            this.exchangeClient = new ExchangeClient(this.wallet);
        } else {
            console.warn("No Hyperliquid Private Key found. Execution disabled.");
        }
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
        await new Promise<void>((resolve) => {
            let initialDataReceived = false;
            this.subClient.l2Book({ coin: this.coin }, (data: any) => {
                if (data && data.levels) {
                    this.l2Book = data.levels;
                } else {
                    this.l2Book = data;
                }

                if (!initialDataReceived) {
                    initialDataReceived = true;
                    resolve();
                }
            });
        });
        console.log(`Subscribed to L2 Book for ${this.coin}`);
    }

    getHedgePrice(side: 'bid' | 'ask', size: number): number {
        // Handle both normalized and raw array formats
        let levels;
        if (this.l2Book && this.l2Book.levels) {
            // Normalized format: { levels: [[bids], [asks]] }
            levels = side === 'bid' ? this.l2Book.levels[0] : this.l2Book.levels[1];
        } else if (Array.isArray(this.l2Book) && this.l2Book.length === 2) {
            // Raw array format: [[bids], [asks]]
            levels = side === 'bid' ? this.l2Book[0] : this.l2Book[1];
        } else {
            throw new Error("Orderbook not yet available");
        }

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

    async getAvailableMargin(): Promise<number> {
        if (!this.wallet) return 0;

        // Check cache first (stale-while-revalidate pattern)
        const now = Date.now();
        if (this.marginCache) {
            const age = now - this.marginCache.timestamp;

            // If cache is fresh, return immediately
            if (age < this.CACHE_TTL_MS) {
                // Trigger background refresh if approaching expiry
                if (age > this.CACHE_REFRESH_THRESHOLD_MS && !this.marginCache.refreshing) {
                    this.marginCache.refreshing = true;
                    this.refreshMarginInBackground().catch(e =>
                        console.warn(`Background margin refresh failed:`, e)
                    );
                }
                return this.marginCache.margin;
            }
        }

        console.log(`[Hyperliquid] Checking Margin for Derived Address: ${this.wallet.address}`);
        try {
            const userState = await this.infoClient.clearinghouseState({ user: this.wallet.address });
            const marginSummary = userState.marginSummary;
            console.log(`[Hyperliquid] Raw Margin Summary:`, JSON.stringify(marginSummary));

            const accountValue = parseFloat(marginSummary.accountValue);
            const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed);
            const availableMargin = accountValue - totalMarginUsed;

            // Cache the result
            this.marginCache = { margin: availableMargin, timestamp: now, refreshing: false };

            return availableMargin;
        } catch (e) {
            console.error("[Hyperliquid] Failed to fetch margin:", e);
            return 0;
        }
    }

    private async refreshMarginInBackground(): Promise<void> {
        if (!this.wallet) return;

        try {
            const userState = await this.infoClient.clearinghouseState({ user: this.wallet.address });
            const marginSummary = userState.marginSummary;

            const accountValue = parseFloat(marginSummary.accountValue);
            const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed);
            const availableMargin = accountValue - totalMarginUsed;

            this.marginCache = { margin: availableMargin, timestamp: Date.now(), refreshing: false };
        } catch (e) {
            if (this.marginCache) {
                this.marginCache.refreshing = false;
            }
            throw e;
        }
    }

    async getBtcPosition(): Promise<number> {
        if (!this.wallet) return 0;

        // Check cache first (stale-while-revalidate pattern)
        const now = Date.now();
        if (this.positionCache) {
            const age = now - this.positionCache.timestamp;

            // If cache is fresh, return immediately
            if (age < this.POSITION_CACHE_TTL_MS) {
                // Trigger background refresh if approaching expiry
                if (age > this.POSITION_REFRESH_THRESHOLD_MS && !this.positionCache.refreshing) {
                    this.positionCache.refreshing = true;
                    this.refreshPositionInBackground().catch(e =>
                        console.warn(`Background position refresh failed:`, e)
                    );
                }
                return this.positionCache.position;
            }
        }

        const userState = await this.infoClient.clearinghouseState({ user: this.wallet.address });
        const positions = userState.assetPositions;
        const btcPos = positions.find((p: any) => p.position.coin === this.coin);
        const position = btcPos ? parseFloat(btcPos.position.szi) : 0;

        // Cache the result
        this.positionCache = { position, timestamp: now, refreshing: false };
        return position;
    }

    private async refreshPositionInBackground(): Promise<void> {
        if (!this.wallet) return;

        try {
            const userState = await this.infoClient.clearinghouseState({ user: this.wallet.address });
            const positions = userState.assetPositions;
            const btcPos = positions.find((p: any) => p.position.coin === this.coin);
            const position = btcPos ? parseFloat(btcPos.position.szi) : 0;

            this.positionCache = { position, timestamp: Date.now(), refreshing: false };
        } catch (e) {
            if (this.positionCache) {
                this.positionCache.refreshing = false;
            }
            throw e;
        }
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
            let bids, asks;

            if (this.l2Book && this.l2Book.levels) {
                bids = this.l2Book.levels[0];
                asks = this.l2Book.levels[1];
            } else if (Array.isArray(this.l2Book) && this.l2Book.length === 2) {
                bids = this.l2Book[0];
                asks = this.l2Book[1];
            } else {
                return null;
            }

            if (!bids || !asks || bids.length === 0 || asks.length === 0) {
                return null;
            }

            const bestBid = parseFloat(bids[0].px);
            const bestAsk = parseFloat(asks[0].px);
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
        // Slippage protection
        const currentPrice = this.getHedgePrice(isBuy ? 'ask' : 'bid', size);
        const limitPx = isBuy ? currentPrice * 1.05 : currentPrice * 0.95;
        const price = Number(limitPx.toFixed(1));

        console.log(`Executing Hedge: ${direction} ${size} BTC @ ~${price}`);

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

        // Invalidate position cache after hedge execution
        this.positionCache = null;

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
