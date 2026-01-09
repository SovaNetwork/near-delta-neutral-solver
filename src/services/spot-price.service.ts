import axios from 'axios';
import https from 'https';

// HTTP agent with keep-alive for connection reuse
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 3,
    maxFreeSockets: 2,
});

type PriceSource = 'coinbase' | 'binance';

/**
 * Spot price service for BTC
 * Used to calculate basis (spot vs perp) for dynamic spread adjustment
 *
 * Sources:
 * - Coinbase: 600 req/min, native cbBTC support
 * - Binance: 1200 req/min, may be geo-restricted
 */
export class SpotPriceService {
    private btcPrice: number | null = null;
    private lastUpdate: number = 0;
    private updateIntervalMs: number;
    private updateTimer: NodeJS.Timeout | null = null;
    private primarySource: PriceSource;
    private fallbackEnabled: boolean;

    constructor() {
        this.updateIntervalMs = parseInt(process.env.SPOT_PRICE_UPDATE_INTERVAL_MS || '10000', 10);
        this.primarySource = (process.env.SPOT_PRICE_SOURCE as PriceSource) || 'coinbase';
        this.fallbackEnabled = process.env.SPOT_PRICE_FALLBACK !== 'false';
    }

    /**
     * Fetch BTC price from Coinbase
     */
    private async fetchCoinbasePrice(): Promise<number | null> {
        try {
            const response = await axios.get<{ data: { amount: string } }>(
                'https://api.coinbase.com/v2/prices/BTC-USD/spot',
                { timeout: 5000, httpsAgent }
            );
            return parseFloat(response.data.data.amount);
        } catch (error: any) {
            if (error.response?.status === 429) {
                console.warn('[SpotPrice] Coinbase rate limit hit');
            }
            return null;
        }
    }

    /**
     * Fetch BTC price from Binance
     */
    private async fetchBinancePrice(): Promise<number | null> {
        try {
            const response = await axios.get<{ price: string }>(
                'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
                { timeout: 5000, httpsAgent }
            );
            return parseFloat(response.data.price);
        } catch (error: any) {
            if (error.response?.status === 429) {
                console.warn('[SpotPrice] Binance rate limit hit');
            }
            return null;
        }
    }

    /**
     * Update BTC price from configured sources
     */
    public async updatePrice(): Promise<void> {
        let price: number | null = null;

        // Try primary source
        if (this.primarySource === 'coinbase') {
            price = await this.fetchCoinbasePrice();
        } else {
            price = await this.fetchBinancePrice();
        }

        // Try fallback if primary failed
        if (price === null && this.fallbackEnabled) {
            if (this.primarySource === 'coinbase') {
                price = await this.fetchBinancePrice();
            } else {
                price = await this.fetchCoinbasePrice();
            }
        }

        if (price !== null) {
            this.btcPrice = price;
            this.lastUpdate = Date.now();
        }
    }

    /**
     * Get cached BTC spot price
     */
    public getBtcPrice(): number | null {
        return this.btcPrice;
    }

    /**
     * Check if price is stale
     */
    public isStale(): boolean {
        if (this.btcPrice === null) return true;
        const staleThresholdMs = this.updateIntervalMs * 3;
        return Date.now() - this.lastUpdate > staleThresholdMs;
    }

    /**
     * Get last update timestamp
     */
    public getLastUpdateTime(): number {
        return this.lastUpdate;
    }

    /**
     * Calculate basis: (perp - spot) / spot
     * Positive basis = perp trading at premium (favorable for shorts)
     * Negative basis = perp trading at discount (unfavorable for shorts)
     *
     * @param perpMidPrice Current perp mid price from Hyperliquid
     * @returns Basis in decimal form (e.g., 0.001 = 0.1% = 10 bps)
     */
    public calculateBasis(perpMidPrice: number): number | null {
        if (this.btcPrice === null || this.isStale()) {
            return null;
        }
        return (perpMidPrice - this.btcPrice) / this.btcPrice;
    }

    /**
     * Calculate basis in bps for logging/display
     */
    public calculateBasisBps(perpMidPrice: number): number | null {
        const basis = this.calculateBasis(perpMidPrice);
        if (basis === null) return null;
        return basis * 10000;
    }

    /**
     * Start background price updates
     */
    public async start(): Promise<void> {
        // Initial update
        await this.updatePrice();

        // Set up periodic updates
        this.updateTimer = setInterval(() => {
            this.updatePrice().catch((error) => {
                console.error('[SpotPrice] Price update failed:', error.message);
            });
        }, this.updateIntervalMs);

        console.log(`[SpotPrice] Started (source: ${this.primarySource}, interval: ${this.updateIntervalMs}ms)`);
        if (this.btcPrice) {
            console.log(`[SpotPrice] Initial BTC spot price: $${this.btcPrice.toFixed(2)}`);
        }
    }

    /**
     * Stop background price updates
     */
    public stop(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
            console.log('[SpotPrice] Stopped');
        }
    }

    /**
     * Get status for monitoring
     */
    public getStatus(): { price: number | null; lastUpdate: number; stale: boolean; source: string } {
        return {
            price: this.btcPrice,
            lastUpdate: this.lastUpdate,
            stale: this.isStale(),
            source: this.primarySource,
        };
    }
}
