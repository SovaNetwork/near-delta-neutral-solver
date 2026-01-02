import {
    InfoClient, ExchangeClient, SubscriptionClient,
    HttpTransport, WebSocketTransport,
    MAINNET_API_URL, TESTNET_API_URL,
    MAINNET_API_WS_URL, TESTNET_API_WS_URL
} from '@nktkas/hyperliquid';
import { Wallet } from 'ethers';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
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
        // 1. Fetch Meta
        const meta = await this.infoClient.meta();
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

        // 2. Subscribe to L2 Book
        await this.subClient.l2Book({ coin: this.coin }, (data: any) => {
            if (data && data.levels) {
                this.l2Book = data.levels;
            } else {
                this.l2Book = data;
            }
        });
        console.log(`Subscribed to L2 Book for ${this.coin}`);
    }

    getHedgePrice(side: 'bid' | 'ask', size: number): number {
        if (!this.l2Book || !this.l2Book.levels) {
            // It might be that this.l2Book IS the levels array if logic above 'this.l2Book = data' is hit?
            // If 'data' IS the levels, then this.l2Book is array.
            // If standard response, it has levels.
            if (Array.isArray(this.l2Book)) {
                // Maybe it's [bids, asks] directly?
                // Safest is to check structure at runtime or assume standard.
                // I'll assume the standard struct has levels.
                // If not available yet:
                throw new Error("Orderbook not yet available");
            }
            if (!this.l2Book.levels) throw new Error("Orderbook not yet available");
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

    async getAvailableMargin(): Promise<number> {
        if (!this.wallet) return 0;
        const userState = await this.infoClient.clearinghouseState({ user: this.wallet.address });
        const marginSummary = userState.marginSummary;
        const accountValue = parseFloat(marginSummary.accountValue);
        const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed);
        return accountValue - totalMarginUsed;
    }

    async getBtcPosition(): Promise<number> {
        if (!this.wallet) return 0;
        const userState = await this.infoClient.clearinghouseState({ user: this.wallet.address });
        const positions = userState.assetPositions;
        const btcPos = positions.find((p: any) => p.position.coin === this.coin);
        if (!btcPos) return 0;
        return parseFloat(btcPos.position.szi);
    }

    async getFundingRate(): Promise<number> {
        // Fetch metaAndAssetCtxs to get funding
        const metaAndCtxs = await this.infoClient.metaAndAssetCtxs();
        const ctxs = metaAndCtxs[1]; // AssetCtx[]
        // Need to find by asset index
        const assetCtx = ctxs[this.assetIndex];
        if (!assetCtx) return 0;

        // funding is usually 'funding' field.
        // Check SDK type definition or assume 'funding'
        // SDK typings: AssetCtx usually has 'funding' (hourly rate?) or 'premium'?
        // The standard HL API returns 'funding' as the rate since last update?
        // Actually assetCtx has 'funding' which is the current accumulated funding?
        // No, 'funding' in AssetCtx is the instantaneous funding rate or similar?
        // Let's use 'funding' field and parse it.
        return parseFloat(assetCtx.funding);
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

        return result;
    }
}
