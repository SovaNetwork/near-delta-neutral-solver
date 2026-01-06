import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { NEAR_CONFIG } from '../configs/near.config';

interface QuoteData {
    direction: 'short' | 'long'; // If we bought BTC, we execute 'short'.
    amountBtc: number;
    quoteId: string;
    timestamp: number;
}

import { LoggerService } from './logger.service';

export class HedgerService {
    private pendingQuotes = new Map<string, QuoteData>(); // nonce -> data
    private pollInterval: NodeJS.Timeout | null = null;
    private processing = false; // Simple lock to avoid overlapping polls if slow
    private readonly POLL_INTERVAL_MS = 5000; // Check every 5 seconds (reduced from 2s to avoid rate limits)
    private readonly MAX_CONCURRENT_NONCE_CHECKS = 3; // Max parallel nonce checks to avoid RPC rate limits
    private readonly NONCE_CHECK_DELAY_MS = 100; // Delay between batch checks

    constructor(
        private nearService: NearService,
        private hlService: HyperliquidService,
        private logger: LoggerService
    ) { }

    start() {
        if (this.pollInterval) return;
        console.log("Hedger Service Started.");
        this.pollInterval = setInterval(() => this.poll(), this.POLL_INTERVAL_MS);
    }

    trackQuote(nonce: string, data: Omit<QuoteData, 'timestamp'>) {
        this.pendingQuotes.set(nonce, { ...data, timestamp: Date.now() });
        console.log(`Tracking Quote ${nonce} for settlement...`);
    }

    private async poll() {
        if (this.processing) return;
        this.processing = true;

        try {
            // Check for timeouts
            const now = Date.now();
            for (const [nonce, data] of this.pendingQuotes.entries()) {
                if (data.timestamp && now - data.timestamp > 300000) { // 5 mins
                    console.log(`Quote ${nonce} expired.`);
                    this.pendingQuotes.delete(nonce);
                    this.logger.logTrade({
                        type: 'QUOTE_EXPIRED',
                        nonce,
                        direction: data.direction,
                        amountBtc: data.amountBtc,
                        error: 'Expired'
                    });
                }
            }

            // Check nonces in small batches to avoid RPC rate limits
            const noncesArray = Array.from(this.pendingQuotes.entries());
            const nonceResults: { nonce: string; data: QuoteData; isUsed: boolean }[] = [];

            // Process in batches of MAX_CONCURRENT_NONCE_CHECKS
            for (let i = 0; i < noncesArray.length; i += this.MAX_CONCURRENT_NONCE_CHECKS) {
                const batch = noncesArray.slice(i, i + this.MAX_CONCURRENT_NONCE_CHECKS);

                const batchResults = await Promise.all(
                    batch.map(async ([nonce, data]) => {
                        try {
                            const isUsed = await this.nearService.wasNonceUsed(nonce);
                            return { nonce, data, isUsed };
                        } catch (e: any) {
                            // Don't spam logs for rate limit errors
                            if (!e?.message?.includes('429') && !e?.message?.includes('Rate limit')) {
                                console.error(`Error checking nonce ${nonce}:`, e);
                            }
                            return { nonce, data, isUsed: false };
                        }
                    })
                );

                nonceResults.push(...batchResults);

                // Add delay between batches to avoid rate limits
                if (i + this.MAX_CONCURRENT_NONCE_CHECKS < noncesArray.length) {
                    await new Promise(r => setTimeout(r, this.NONCE_CHECK_DELAY_MS));
                }
            }

            // Process all used nonces
            for (const { nonce, data, isUsed } of nonceResults) {
                if (isUsed) {
                    console.log(`Settlement Detected for nonce ${nonce}! Executing Hedge...`);
                    this.pendingQuotes.delete(nonce);

                    if (data) {
                        try {
                            const result = await this.hlService.executeHedge(data.direction, data.amountBtc);
                            console.log(`Hedge Completed for ${nonce}`);

                            // Parse result for price
                            let execPx = 0;
                            if (result && result.response && result.response.data && result.response.data.statuses && result.response.data.statuses.length > 0) {
                                const status = result.response.data.statuses[0];
                                if (typeof status === 'object' && 'filled' in status) {
                                    execPx = parseFloat(status.filled.avgPx);
                                }
                            }

                            this.logger.logTrade({
                                type: 'HEDGE_EXECUTED',
                                nonce,
                                direction: data.direction,
                                amountBtc: data.amountBtc,
                                executionPrice: execPx,
                                timestamp: new Date().toISOString()
                            });

                        } catch (hedgeErr) {
                            console.error(`[ALERT] HIGH PRIORITY: Failed to hedge ${nonce}:`, hedgeErr);
                            console.error(`[ALERT] Drift Impact: ${data.direction} ${data.amountBtc} BTC unhedged. Manual intervention required.`);

                            this.logger.logTrade({
                                type: 'HEDGE_FAILED',
                                nonce,
                                direction: data.direction,
                                amountBtc: data.amountBtc,
                                error: String(hedgeErr),
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                }
            }

        } catch (e) {
            console.error("Hedger Loop Error:", e);
        } finally {
            this.processing = false;
        }
    }

    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
            console.log("Hedger Service Stopped.");
        }
    }

    getPendingQuotes() {
        return Array.from(this.pendingQuotes.entries()).map(([nonce, data]) => ({
            nonce,
            ...data
        }));
    }
}
