import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { InventoryStateService } from './inventory-manager.service';
import { NEAR_CONFIG } from '../configs/near.config';
import { LoggerService, shortId } from './logger.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

interface QuoteData {
    direction: 'short' | 'long'; // If we bought BTC, we execute 'short'.
    amountBtc: number;
    quoteId: string;
    timestamp: number;
    deadlineMs: number; // Actual deadline for this quote
}

export class HedgerService {
    private pendingQuotes = new Map<string, QuoteData>(); // nonce -> data
    private pollInterval: NodeJS.Timeout | null = null;
    private processing = false; // Simple lock to avoid overlapping polls if slow
    private readonly POLL_INTERVAL_MS = 1500; // Check every 1.5 seconds for faster hedge execution
    private readonly MAX_CONCURRENT_NONCE_CHECKS = 5; // Max parallel nonce checks
    private readonly NONCE_CHECK_DELAY_MS = 50; // Delay between batch checks
    private consecutiveRpcFailures = 0;
    private readonly MAX_RPC_FAILURES_BEFORE_EMERGENCY = 5;

    constructor(
        private nearService: NearService,
        private hlService: HyperliquidService,
        private inventoryManager: InventoryStateService,
        private logger: LoggerService
    ) { }

    start() {
        if (this.pollInterval) return;
        if (!BTC_ONLY_CONFIG.HEDGING_ENABLED) {
            console.log("[HEDGER] WARN: Hedging is DISABLED via HEDGING_ENABLED=false");
        }
        console.log("[HEDGER] Service Started.");
        this.pollInterval = setInterval(() => this.poll(), this.POLL_INTERVAL_MS);
    }

    trackQuote(nonce: string, data: Omit<QuoteData, 'timestamp' | 'deadlineMs'> & { deadlineMs: number }) {
        this.pendingQuotes.set(nonce, { ...data, timestamp: Date.now() });
        console.log(`🔄 [${shortId(nonce)}] TRACKING | awaiting settlement...`);
    }

    removeQuote(nonce: string) {
        this.pendingQuotes.delete(nonce);
    }

    private async poll() {
        if (this.processing) return;
        this.processing = true;

        try {
            // Check for timeouts based on actual quote deadline + safety buffer
            const now = Date.now();
            const SAFETY_BUFFER_MS = 30000; // 30s buffer after deadline
            for (const [nonce, data] of this.pendingQuotes.entries()) {
                const expiryTime = data.deadlineMs + SAFETY_BUFFER_MS;
                if (now > expiryTime) {
                    const expiredAfterMs = now - data.timestamp;
                    console.log(`⏰ [${shortId(nonce)}] EXPIRED | no settlement after ${Math.round(expiredAfterMs / 1000)}s`);
                    this.pendingQuotes.delete(nonce);
                    this.logger.logTrade({
                        type: 'QUOTE_EXPIRED',
                        nonce,
                        direction: data.direction,
                        amountBtc: data.amountBtc,
                        error: `Expired after ${Math.round(expiredAfterMs / 1000)}s`
                    });
                }
            }

            // Check nonces in small batches to avoid RPC rate limits
            const noncesArray = Array.from(this.pendingQuotes.entries());
            const nonceResults: { nonce: string; data: QuoteData; isUsed: boolean }[] = [];
            let batchHadRpcFailure = false;

            // Process in batches of MAX_CONCURRENT_NONCE_CHECKS
            for (let i = 0; i < noncesArray.length; i += this.MAX_CONCURRENT_NONCE_CHECKS) {
                const batch = noncesArray.slice(i, i + this.MAX_CONCURRENT_NONCE_CHECKS);

                const batchResults = await Promise.all(
                    batch.map(async ([nonce, data]) => {
                        try {
                            const isUsed = await this.nearService.wasNonceUsed(nonce);
                            return { nonce, data, isUsed, failed: false };
                        } catch (e: any) {
                            batchHadRpcFailure = true;
                            // Don't spam logs for rate limit errors
                            if (!e?.message?.includes('429') && !e?.message?.includes('Rate limit')) {
                                console.error(`Error checking nonce ${nonce}:`, e);
                            }
                            return { nonce, data, isUsed: false, failed: true };
                        }
                    })
                );

                nonceResults.push(...batchResults.map(r => ({ nonce: r.nonce, data: r.data, isUsed: r.isUsed })));

                // Add delay between batches to avoid rate limits
                if (i + this.MAX_CONCURRENT_NONCE_CHECKS < noncesArray.length) {
                    await new Promise(r => setTimeout(r, this.NONCE_CHECK_DELAY_MS));
                }
            }

            // Track consecutive RPC failures and trigger emergency mode if too many
            if (batchHadRpcFailure) {
                this.consecutiveRpcFailures++;
                if (this.consecutiveRpcFailures >= this.MAX_RPC_FAILURES_BEFORE_EMERGENCY) {
                    console.error(`[ERROR] NEAR RPC unhealthy (${this.consecutiveRpcFailures} consecutive failures) - enabling emergency mode`);
                    this.inventoryManager.setEmergencyMode(true);
                }
            } else if (noncesArray.length > 0) {
                // Reset counter on successful batch (only if we actually checked something)
                if (this.consecutiveRpcFailures > 0) {
                    console.log(`✅ NEAR RPC recovered after ${this.consecutiveRpcFailures} failures`);
                }
                this.consecutiveRpcFailures = 0;
            }

            // Process all used nonces
            for (const { nonce, data, isUsed } of nonceResults) {
                if (isUsed) {
                    console.log(`💰 [${shortId(nonce)}] SETTLED | executing hedge...`);
                    this.pendingQuotes.delete(nonce);

                    if (data) {
                        // Check if hedging is disabled via circuit breaker
                        if (!BTC_ONLY_CONFIG.HEDGING_ENABLED) {
                            console.log(`[HEDGER] SKIP [${shortId(nonce)}] | hedging disabled | would ${data.direction} ${data.amountBtc.toFixed(6)} BTC`);
                            this.logger.logTrade({
                                type: 'SETTLEMENT_DETECTED',
                                nonce,
                                direction: data.direction,
                                amountBtc: data.amountBtc,
                                reason: 'hedging_disabled',
                                timestamp: new Date().toISOString()
                            });
                            continue;
                        }

                        try {
                            const result = await this.hlService.executeHedge(data.direction, data.amountBtc);
                            console.log(`✅ [${shortId(nonce)}] HEDGED | ${data.direction} ${data.amountBtc.toFixed(6)} BTC`);

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

                            // Auto-recover from emergency mode after successful hedge
                            if (this.inventoryManager.isEmergencyMode()) {
                                console.log("✅ Hedge succeeded - clearing emergency mode");
                                this.inventoryManager.setEmergencyMode(false);
                            }

                        } catch (hedgeErr) {
                            console.error(`[ERROR] [${shortId(nonce)}] HEDGE FAILED | ${data.direction} ${data.amountBtc.toFixed(6)} BTC`, hedgeErr);
                            console.error(`[ERROR] MANUAL INTERVENTION REQUIRED - unhedged position!`);
                            console.error(`[ERROR] ENABLING EMERGENCY MODE - stopping all quotes`);

                            // Circuit breaker: stop quoting when hedge fails
                            this.inventoryManager.setEmergencyMode(true);

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
