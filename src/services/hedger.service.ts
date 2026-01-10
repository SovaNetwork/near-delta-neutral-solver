import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { InventoryStateService } from './inventory-manager.service';
import { NEAR_CONFIG } from '../configs/near.config';
import { LoggerService, shortId, ConsoleFormat } from './logger.service';
import { TraceService } from './trace.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

interface QuoteData {
    direction: 'short' | 'long'; // If we bought BTC, we execute 'short'.
    amountBtc: number;
    quoteId: string;
    timestamp: number;
    deadlineMs: number; // Actual deadline for this quote
    quotedPrice?: number; // For P&L calculation
    spreadBps?: number; // For tracking
}

export class HedgerService {
    private pendingQuotes = new Map<string, QuoteData>(); // nonce -> data
    private hedgedNonces = new Set<string>(); // Track already-hedged nonces to prevent double-hedging
    private pollInterval: NodeJS.Timeout | null = null;
    private processing = false; // Simple lock to avoid overlapping polls if slow
    private readonly POLL_INTERVAL_MS = 1500; // Check every 1.5 seconds for faster hedge execution
    private readonly MAX_CONCURRENT_NONCE_CHECKS = 5; // Max parallel nonce checks
    private readonly NONCE_CHECK_DELAY_MS = 50; // Delay between batch checks
    private readonly HEDGED_NONCES_MAX_SIZE = 500; // Prevent memory leak
    private consecutiveRpcFailures = 0;
    private readonly MAX_RPC_FAILURES_BEFORE_EMERGENCY = 5;

    constructor(
        private nearService: NearService,
        private hlService: HyperliquidService,
        private inventoryManager: InventoryStateService,
        private logger: LoggerService,
        private traceService?: TraceService
    ) { }

    start() {
        if (this.pollInterval) return;
        if (!BTC_ONLY_CONFIG.HEDGING_ENABLED) {
            console.log("[HEDGER] WARN: Hedging is DISABLED via HEDGING_ENABLED=false");
        }
        console.log("[HEDGER] Service Started.");
        this.pollInterval = setInterval(() => this.poll(), this.POLL_INTERVAL_MS);
    }

    trackQuote(nonce: string, data: Omit<QuoteData, 'timestamp'>) {
        this.pendingQuotes.set(nonce, { ...data, timestamp: Date.now() });
        
        // Start trace if TraceService is available
        if (this.traceService && data.quotedPrice) {
            const direction = data.direction === 'short' ? 'BUY' : 'SELL';
            this.traceService.startTrace(nonce, direction, data.amountBtc, data.quotedPrice, data.spreadBps || 0);
        }
        
        console.log(`${ConsoleFormat.symbols.pending} [${shortId(nonce)}] TRACKING | ${data.direction} ${data.amountBtc.toFixed(6)} BTC | awaiting settlement...`);
    }

    removeQuote(nonce: string) {
        this.pendingQuotes.delete(nonce);
    }

    /**
     * Check if a nonce was already hedged (idempotency guard)
     */
    wasAlreadyHedged(nonce: string): boolean {
        return this.hedgedNonces.has(nonce);
    }

    /**
     * Mark a nonce as hedged to prevent double-hedging
     */
    markAsHedged(nonce: string): void {
        this.hedgedNonces.add(nonce);
        // Prevent memory leak - trim old entries if too large
        if (this.hedgedNonces.size > this.HEDGED_NONCES_MAX_SIZE) {
            const toDelete = Array.from(this.hedgedNonces).slice(0, 100);
            toDelete.forEach(n => this.hedgedNonces.delete(n));
        }
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
                    console.log(`${ConsoleFormat.symbols.expired} [${shortId(nonce)}] EXPIRED | no settlement after ${Math.round(expiredAfterMs / 1000)}s`);
                    this.pendingQuotes.delete(nonce);
                    this.traceService?.recordExpired(nonce);
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
                    this.pendingQuotes.delete(nonce);

                    // Idempotency check - prevent double-hedging if quote_status already handled this
                    if (this.wasAlreadyHedged(nonce)) {
                        console.log(`[HEDGER] [${shortId(nonce)}] Already hedged, skipping`);
                        continue;
                    }

                    console.log(`${ConsoleFormat.symbols.settlement} [${shortId(nonce)}] SETTLED via polling | executing hedge...`);
                    this.traceService?.recordSettlement(nonce);
                    this.traceService?.markWon(nonce);

                    if (data) {
                        // Check if hedging is disabled via circuit breaker
                        if (!BTC_ONLY_CONFIG.HEDGING_ENABLED) {
                            console.log(`[HEDGER] SKIP [${shortId(nonce)}] | hedging disabled | would ${data.direction} ${data.amountBtc.toFixed(6)} BTC`);
                            this.markAsHedged(nonce); // Mark to prevent re-processing
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
                            this.traceService?.recordHedgeStart(nonce);
                            const result = await this.hlService.executeHedge(data.direction, data.amountBtc);
                            this.markAsHedged(nonce); // Mark as hedged immediately after success
                            
                            // Calculate P&L if we have quoted price
                            const pnlUsd = data.quotedPrice && result.avgPrice 
                                ? (data.direction === 'short' 
                                    ? (result.avgPrice - data.quotedPrice) * data.amountBtc  // Short: profit if hedge > quote
                                    : (data.quotedPrice - result.avgPrice) * data.amountBtc) // Long: profit if quote > hedge
                                : undefined;
                            
                            const pnlStr = pnlUsd !== undefined ? ` | P&L:$${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)}` : '';
                            console.log(`${ConsoleFormat.symbols.success} [${shortId(nonce)}] HEDGED | ${data.direction} ${data.amountBtc.toFixed(6)} BTC @ $${result.avgPrice.toFixed(2)}${pnlStr}`);

                            this.traceService?.recordHedgeSuccess(nonce, result.avgPrice, data.amountBtc);
                            
                            this.logger.logTrade({
                                type: 'HEDGE_EXECUTED',
                                nonce,
                                direction: data.direction,
                                amountBtc: data.amountBtc,
                                executionPrice: result.avgPrice,
                                quotedPrice: data.quotedPrice,
                                spreadBps: data.spreadBps,
                                pnlUsd,
                                timestamp: new Date().toISOString()
                            });

                            // Auto-recover from emergency mode after successful hedge
                            if (this.inventoryManager.isEmergencyMode()) {
                                console.log(`${ConsoleFormat.symbols.success} Hedge succeeded - clearing emergency mode`);
                                this.inventoryManager.setEmergencyMode(false);
                            }

                        } catch (hedgeErr) {
                            console.error(`${ConsoleFormat.symbols.failure} [${shortId(nonce)}] HEDGE FAILED | ${data.direction} ${data.amountBtc.toFixed(6)} BTC`, hedgeErr);
                            console.error(`${ConsoleFormat.symbols.emergency} MANUAL INTERVENTION REQUIRED - unhedged position!`);
                            console.error(`${ConsoleFormat.symbols.emergency} ENABLING EMERGENCY MODE - stopping all quotes`);

                            // Circuit breaker: stop quoting when hedge fails
                            this.inventoryManager.setEmergencyMode(true);
                            this.traceService?.recordHedgeFailure(nonce, String(hedgeErr));

                            this.logger.logTrade({
                                type: 'HEDGE_FAILED',
                                nonce,
                                direction: data.direction,
                                amountBtc: data.amountBtc,
                                quotedPrice: data.quotedPrice,
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
