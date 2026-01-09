import { NearService } from './services/near.service';
import { HyperliquidService } from './services/hyperliquid.service';
import { InventoryStateService } from './services/inventory-manager.service';
import { QuoterService } from './services/quoter.service';
import { HedgerService } from './services/hedger.service';
import { CronService } from './services/cron.service';
import { LoggerService, shortId } from './services/logger.service';
import { ApiService } from './services/api.service';
import { BTC_ONLY_CONFIG } from './configs/btc-only.config';
import { NEAR_CONFIG } from './configs/near.config';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import { performance } from 'perf_hooks';
import bs58 from 'bs58';
import { SignStandardEnum, IMessage } from './interfaces/intents.interface';
import { serializeIntent, generateRandomNonce } from './utils/hashing';

dotenv.config();

const SOLVER_BUS_WS = process.env.SOLVER_BUS_WS_URL || 'wss://solver-relay-v2.chaindefuser.com/ws';

// Global retry state for simplicity
let reconnectAttempts = 0;

// Helper functions hoisted out of WS handler (avoid re-allocation per message)
const STRIP_PREFIX_REGEX = /^nep\d+:/;
const stripPrefix = (tokenId: string) => tokenId.replace(STRIP_PREFIX_REGEX, '');

// Cached quote data for settlement matching
interface CachedQuote {
    nonce: string;
    quoteHash: string;  // Used to match quote_status events
    direction: 'short' | 'long';
    amountBtc: number;
    deadlineMs: number;
    timestamp: number;
}

// Context to share mutable WebSocket reference
interface SolverContext {
    ws: WebSocket | null;
    pendingRequests: Map<number, (response: any) => void>;
    requestCounter: number;
    quoteCache: Map<string, CachedQuote>;  // quoteHash -> quote data
    subscriptionIds: Map<string, string>;  // subscriptionId -> event type
    loggedIntents: Set<string>;  // Deduplicate "other solver won" messages
}

async function main() {
    console.log("Starting Delta-Neutral Solver...");

    // 0. Config Validation
    console.log("Environment Check:");
    console.log("SOLVER_ID:", process.env.SOLVER_ID);
    console.log("SOLVER_PRIVATE_KEY Present:", !!process.env.SOLVER_PRIVATE_KEY);
    console.log("SOLVER_PRIVATE_KEY Length:", process.env.SOLVER_PRIVATE_KEY ? process.env.SOLVER_PRIVATE_KEY.length : 0);

    if (!process.env.SOLVER_PRIVATE_KEY) throw new Error("Missing SOLVER_PRIVATE_KEY");
    if (!process.env.SOLVER_ID) throw new Error("Missing SOLVER_ID");

    console.log("Config Check:");
    console.log("  HYPERLIQUID_MAINNET:", process.env.HYPERLIQUID_MAINNET !== 'false' ? 'true (mainnet)' : 'false (testnet)');
    console.log("  MAX_TRADE_SIZE_BTC:", BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC);
    console.log("  TARGET_SPREAD_BIPS:", BTC_ONLY_CONFIG.TARGET_SPREAD_BIPS);
    console.log("  HEDGE_SLIPPAGE_BPS:", BTC_ONLY_CONFIG.HEDGE_SLIPPAGE_BPS);
    console.log("  MAX_ORDERBOOK_AGE_MS:", BTC_ONLY_CONFIG.MAX_ORDERBOOK_AGE_MS);
    console.log("  HEDGING_ENABLED:", BTC_ONLY_CONFIG.HEDGING_ENABLED ? 'true' : 'false (HEDGING DISABLED!)');

    if (BTC_ONLY_CONFIG.HEDGE_SLIPPAGE_BPS < 1 || BTC_ONLY_CONFIG.HEDGE_SLIPPAGE_BPS > 500) {
        throw new Error(`Invalid HEDGE_SLIPPAGE_BPS: ${BTC_ONLY_CONFIG.HEDGE_SLIPPAGE_BPS} (must be 1-500)`);
    }
    if (BTC_ONLY_CONFIG.MAX_ORDERBOOK_AGE_MS < 100 || BTC_ONLY_CONFIG.MAX_ORDERBOOK_AGE_MS > 30000) {
        throw new Error(`Invalid MAX_ORDERBOOK_AGE_MS: ${BTC_ONLY_CONFIG.MAX_ORDERBOOK_AGE_MS} (must be 100-30000)`);
    }

    // 1. Init Services
    const logger = new LoggerService();
    const nearService = new NearService();
    await nearService.init();

    const hlService = new HyperliquidService();
    await hlService.init();

    // Use PORT env var if available (Railway uses this), otherwise fallback to API_PORT or 3000
    // Note: On Railway, you must listen on process.env.PORT unless you override it in Railway settings.
    const rawPort = process.env.PORT || process.env.API_PORT || '3000';
    const port = parseInt(rawPort);
    console.log(`Port Configuration: Using ${port} (Source: ${process.env.PORT ? 'PORT (Railway)' : (process.env.API_PORT ? 'API_PORT' : 'Default')})`);

    const inventoryManager = new InventoryStateService(nearService, hlService);
    const quoterService = new QuoterService(inventoryManager, hlService, nearService, logger);
    const hedgerService = new HedgerService(nearService, hlService, inventoryManager, logger);
    const cronService = new CronService(nearService, hlService, logger, inventoryManager);
    cronService.setQuoterService(quoterService);  // Wire up for quote stats logging
    const apiService = new ApiService(hedgerService, hlService, nearService, logger, port);

    // Pre-warm risk snapshot before starting services
    console.log("Pre-warming risk snapshot...");
    await inventoryManager.refreshRiskSnapshot();
    if (!inventoryManager.isSnapshotFresh()) {
        console.error("CRITICAL: Failed to initialize risk snapshot. Exiting.");
        process.exit(1);
    }
    console.log("Risk snapshot initialized successfully.");

    hedgerService.start();
    cronService.start();
    apiService.start();

    const ctx: SolverContext = {
        ws: null,
        pendingRequests: new Map(),
        requestCounter: 3, // Start at 3 to avoid collision with subscription ids: 1, 2
        quoteCache: new Map(),
        subscriptionIds: new Map(),
        loggedIntents: new Set(),
    };

    // Graceful Shutdown
    // Registered ONCE here to avoid memory leaks on reconnection
    const cleanup = () => {
        console.log("Shutting down...");
        if (ctx.ws) {
            ctx.ws.close();
            console.log("WebSocket closed.");
        }
        hedgerService.stop();
        cronService.stop();
        apiService.stop();
        hlService.stopHealthCheck();
        process.exit(0);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);

    // 2. Connect to Solver Bus
    await connectToBusWithRetry(ctx, quoterService, hedgerService, nearService, hlService, inventoryManager, logger);
}

async function connectToBusWithRetry(
    ctx: SolverContext,
    quoterService: QuoterService,
    hedgerService: HedgerService,
    nearService: NearService,
    hlService: HyperliquidService,
    inventoryManager: InventoryStateService,
    logger: LoggerService
) {
    if (reconnectAttempts > 0) {
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
        console.log(`Reconnecting in ${delay / 1000}s (Attempt ${reconnectAttempts})...`);
        await new Promise(r => setTimeout(r, delay));
    }

    console.log(`Connecting to Solver Bus: ${SOLVER_BUS_WS}`);

    const wsOptions: any = {
        perMessageDeflate: false, // Disable compression for lower latency
        handshakeTimeout: 2000,
    };
    if (process.env.RELAY_AUTH_KEY) {
        wsOptions.headers = {
            'Authorization': `Bearer ${process.env.RELAY_AUTH_KEY}`
        };
        console.log("Using RELAY_AUTH_KEY for connection.");
    }

    const ws = new WebSocket(SOLVER_BUS_WS, wsOptions);
    ctx.ws = ws;

    ws.on('open', () => {
        console.log('Connected to Solver Bus');
        reconnectAttempts = 0; // Reset on success

        // Optimize TCP socket for low latency
        const socket = (ws as any)?._socket;
        if (socket && typeof socket.setNoDelay === 'function') {
            socket.setNoDelay(true); // Disable Nagle's algorithm
            socket.setKeepAlive(true, 1000);
            console.log('TCP optimizations enabled (NoDelay, KeepAlive)');
        }

        // Subscribe to quote requests
        ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'subscribe',
            params: ['quote']
        }));
        
        // Subscribe to quote_status for instant settlement detection
        ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'subscribe',
            params: ['quote_status']
        }));
        console.log('Subscribed to quote and quote_status streams');
    });

    ws.on('message', async (data: string) => {
        const t0 = performance.now();
        try {
            const msg = JSON.parse(data.toString());

            // Handle RPC responses (has 'id' field matching our requests)
            if (msg.id !== undefined && ctx.pendingRequests.has(msg.id)) {
                const resolver = ctx.pendingRequests.get(msg.id);
                ctx.pendingRequests.delete(msg.id);
                if (resolver) resolver(msg);
                return;
            }

            // Handle subscription confirmation (has 'result' field and 'id' matches our subscription requests)
            if (msg.result && (msg.id === 1 || msg.id === 2)) {
                const eventType = msg.id === 1 ? 'quote' : 'quote_status';
                ctx.subscriptionIds.set(msg.result, eventType);
                console.log(`Subscription confirmed: ${eventType} -> ${msg.result}`);
                return;
            }

            // Route events based on subscription type
            const subscriptionId = msg.params?.subscription;
            const eventType = subscriptionId ? ctx.subscriptionIds.get(subscriptionId) : null;
            
            if (eventType === 'quote_status') {
                // Handle quote_status event (settlement notification)
                const statusData = msg.params?.data;
                if (!statusData) return;
                
                const quoteHash = statusData.quote_hash;
                const cachedQuote = quoteHash ? ctx.quoteCache.get(quoteHash) : null;
                
                if (cachedQuote) {
                    // OUR QUOTE WAS EXECUTED! Execute hedge immediately
                    console.log(`💰 [${shortId(cachedQuote.nonce)}] SETTLED via quote_status | executing hedge...`);

                    ctx.quoteCache.delete(quoteHash);
                    hedgerService.removeQuote(cachedQuote.nonce); // Remove from polling

                    // Check if hedging is disabled via circuit breaker
                    if (!BTC_ONLY_CONFIG.HEDGING_ENABLED) {
                        console.log(`[HEDGER] SKIP [${shortId(cachedQuote.nonce)}] | hedging disabled | would ${cachedQuote.direction} ${cachedQuote.amountBtc.toFixed(6)} BTC`);
                        logger.logTrade({
                            type: 'SETTLEMENT_DETECTED',
                            nonce: cachedQuote.nonce,
                            direction: cachedQuote.direction,
                            amountBtc: cachedQuote.amountBtc,
                            txHash: statusData.tx_hash,
                            reason: 'hedging_disabled',
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        try {
                            const result = await hlService.executeHedge(cachedQuote.direction, cachedQuote.amountBtc);
                            console.log(`✅ [${shortId(cachedQuote.nonce)}] HEDGED | ${cachedQuote.direction} ${cachedQuote.amountBtc.toFixed(6)} BTC | Tx: ${statusData.tx_hash?.substring(0, 8) || 'unknown'}...`);

                            logger.logTrade({
                                type: 'HEDGE_EXECUTED',
                                nonce: cachedQuote.nonce,
                                direction: cachedQuote.direction,
                                amountBtc: cachedQuote.amountBtc,
                                txHash: statusData.tx_hash,
                                timestamp: new Date().toISOString()
                            });
                        } catch (hedgeErr) {
                            console.error(`[ERROR] [${shortId(cachedQuote.nonce)}] HEDGE FAILED | ${cachedQuote.direction} ${cachedQuote.amountBtc.toFixed(6)} BTC`, hedgeErr);
                            inventoryManager.setEmergencyMode(true);

                            logger.logTrade({
                                type: 'HEDGE_FAILED',
                                nonce: cachedQuote.nonce,
                                direction: cachedQuote.direction,
                                amountBtc: cachedQuote.amountBtc,
                                error: String(hedgeErr),
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                } else {
                    // Other solver won - deduplicate by intent_hash to avoid spam
                    const intentHash = statusData.intent_hash;
                    if (intentHash && !ctx.loggedIntents.has(intentHash)) {
                        ctx.loggedIntents.add(intentHash);
                        console.log(`📨 Other solver won | Tx: ${statusData.tx_hash?.substring(0, 8) || 'unknown'}...`);
                        
                        // Cleanup old logged intents (keep last 200 to prevent memory leak)
                        if (ctx.loggedIntents.size > 200) {
                            const toDelete = Array.from(ctx.loggedIntents).slice(0, 100);
                            toDelete.forEach(hash => ctx.loggedIntents.delete(hash));
                        }
                    }
                }
                return;
            }

            // Parse quote request: { method: "event", params: { subscription, data: { quote_id, ... } } }
            const quoteData = msg.params?.data;
            if (!quoteData || !quoteData.quote_id) return;

            const t1 = performance.now();

            // Determine quote type
            const isExactOut = !quoteData.exact_amount_in && !!quoteData.exact_amount_out;

            // Map defuse field names to our internal format (uses hoisted stripPrefix)
            const req = {
                token_in: stripPrefix(quoteData.defuse_asset_identifier_in),
                token_out: stripPrefix(quoteData.defuse_asset_identifier_out),
                amount_in: quoteData.exact_amount_in,    // undefined for exact_out
                amount_out: quoteData.exact_amount_out,  // undefined for exact_in
            };

            const t2 = performance.now();

            // QuoterService handles all validation internally
            const quote = quoterService.getQuote(req);
            const t3 = performance.now();

            if (quote) {
                // Use metadata from quote result (already computed, avoid recomputing)
                const { btcSize, weAreBuyingBtc, btcTokenId, usdTokenId, btcDecimals, usdDecimals } = quote;
                const btcSymbol = BTC_ONLY_CONFIG.getBtcSymbol(btcTokenId);
                const btcPow10 = BTC_ONLY_CONFIG.getBtcPow10(btcTokenId);
                const usdPow10 = BTC_ONLY_CONFIG.getUsdPow10(usdTokenId);
                const pow10In = weAreBuyingBtc ? btcPow10 : usdPow10;
                const pow10Out = weAreBuyingBtc ? usdPow10 : btcPow10;

                // Determine actual amounts based on quote type
                const finalAmountIn = isExactOut ? quote.amount_in! : req.amount_in!;
                const finalAmountOut = isExactOut ? req.amount_out! : quote.amount_out!;
                const amountInFloat = +finalAmountIn / pow10In;
                const amountOutFloat = +finalAmountOut / pow10Out;

                // Build proper intents message
                const quoteDeadlineMs = quoteData.min_deadline_ms + 60000; // Add 60s buffer
                const standard = SignStandardEnum.nep413;

                // Add nep141: prefix back for intents
                const tokenInWithPrefix = `nep141:${req.token_in}`;
                const tokenOutWithPrefix = `nep141:${req.token_out}`;

                const message: IMessage = {
                    signer_id: NEAR_CONFIG.SOLVER_ID,
                    deadline: new Date(Date.now() + quoteDeadlineMs).toISOString(),
                    intents: [
                        {
                            intent: 'token_diff',
                            diff: {
                                [tokenInWithPrefix]: finalAmountIn,
                                [tokenOutWithPrefix]: `-${finalAmountOut}`
                            }
                        }
                    ]
                };

                const messageStr = JSON.stringify(message);
                const nonce = generateRandomNonce();
                const recipient = NEAR_CONFIG.INTENTS_CONTRACT_ID;

                // Use btcSize from quote result (already calculated)
                const amountBtcForHedge = btcSize;

                const t4 = performance.now();
                const quoteHash = serializeIntent(messageStr, recipient, nonce, standard);
                // Synchronous sign for hot path performance
                const signature = nearService.sign(quoteHash);
                const t5 = performance.now();

                // Publish via WebSocket with proper RTT measurement
                try {
                    const requestId = ctx.requestCounter++;

                    // Format quote response to match relay expectations
                    // For exact_amount_in: return amount_out
                    // For exact_amount_out: return amount_in
                    const quoteResponse = {
                        quote_id: quoteData.quote_id,
                        quote_output: isExactOut 
                            ? { amount_in: quote.amount_in }
                            : { amount_out: quote.amount_out },
                        signed_data: {
                            standard,
                            payload: {
                                message: messageStr,
                                nonce,
                                recipient
                            },
                            signature: `ed25519:${bs58.encode(signature)}`,
                            public_key: nearService.getPublicKeyString() // Pre-cached
                        }
                    };

                    const quoteRequest = {
                        jsonrpc: "2.0",
                        id: requestId,
                        method: 'quote_response',
                        params: [quoteResponse]
                    };

                    // Send and wait for relay acknowledgment
                    // Increased timeout for high-latency environments (Amsterdam -> US relay)
                    const responsePromise = new Promise<any>((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            ctx.pendingRequests.delete(requestId);
                            reject(new Error('Quote submission timeout'));
                        }, 8000);

                        ctx.pendingRequests.set(requestId, (response) => {
                            clearTimeout(timeout);
                            if (response.error) {
                                reject(new Error(`Relay error: ${JSON.stringify(response.error)}`));
                            } else {
                                resolve(response.result);
                            }
                        });
                    });

                    ws.send(JSON.stringify(quoteRequest));

                    try {
                        await responsePromise;
                        const t6 = performance.now();

                        const timings = {
                            quote: parseFloat((t3 - t2).toFixed(2)),
                            sign: parseFloat((t5 - t4).toFixed(2)),
                            post: parseFloat((t6 - t5).toFixed(2)),
                            total: parseFloat((t6 - t0).toFixed(2))
                        };

                        // Track quote for settlement ONLY after successful publish
                        // Cache by quote hash for instant quote_status matching
                        const quoteHashB58 = bs58.encode(quoteHash);
                        ctx.quoteCache.set(quoteHashB58, {
                            nonce,
                            quoteHash: quoteHashB58,
                            direction: weAreBuyingBtc ? 'short' : 'long',
                            amountBtc: amountBtcForHedge,
                            deadlineMs: Date.now() + quoteDeadlineMs,
                            timestamp: Date.now(),
                        });
                        
                        // Also track in hedger for nonce-based fallback polling
                        hedgerService.trackQuote(nonce, {
                            direction: weAreBuyingBtc ? 'short' : 'long',
                            amountBtc: amountBtcForHedge,
                            quoteId: nonce,
                            deadlineMs: Date.now() + quoteDeadlineMs
                        });

                        const quoteType = isExactOut ? 'OUT' : 'IN';
                        console.log(`✅ [${shortId(nonce)}] PUBLISHED ${quoteType} | ${weAreBuyingBtc ? 'BUY' : 'SELL'} ${btcSymbol} ${amountInFloat.toFixed(6)} → ${amountOutFloat.toFixed(6)} | total:${timings.total}ms quote:${timings.quote}ms sign:${timings.sign}ms net:${timings.post}ms`);

                        logger.logTrade({
                            type: 'QUOTE_PUBLISHED',
                            nonce,
                            direction: weAreBuyingBtc ? 'buy' : 'sell',
                            amountBtc: amountBtcForHedge,
                            timings
                        });
                    } catch (relayErr: any) {
                        const t6 = performance.now();
                        const timings = {
                            quote: parseFloat((t3 - t2).toFixed(2)),
                            sign: parseFloat((t5 - t4).toFixed(2)),
                            post: parseFloat((t6 - t5).toFixed(2)),
                            total: parseFloat((t6 - t0).toFixed(2))
                        };

                        // Check if this is "another solver won" error
                        const errorMessage = relayErr?.message || String(relayErr);
                        if (errorMessage.includes('-32098') || errorMessage.includes('not found or already finished')) {
                            const quoteType = isExactOut ? 'OUT' : 'IN';
                            console.log(`❌ [${shortId(nonce)}] REJECTED ${quoteType} | ${weAreBuyingBtc ? 'BUY' : 'SELL'} ${btcSymbol} ${amountInFloat.toFixed(6)} | total:${timings.total}ms quote:${timings.quote}ms sign:${timings.sign}ms net:${timings.post}ms`);

                            logger.logTrade({
                                type: 'QUOTE_REJECTED',
                                nonce,
                                direction: weAreBuyingBtc ? 'buy' : 'sell',
                                amountBtc: amountBtcForHedge,
                                reason: 'solver_lost',
                                timings
                            });
                        } else {
                            console.error(`❌ [${shortId(nonce)}] FAILED:`, relayErr);

                            logger.logTrade({
                                type: 'QUOTE_REJECTED',
                                nonce,
                                direction: weAreBuyingBtc ? 'buy' : 'sell',
                                amountBtc: amountBtcForHedge,
                                reason: 'error',
                                error: errorMessage,
                                timings
                            });
                        }
                    }

                } catch (postErr) {
                    console.error("Failed to publish quote:", postErr);
                }
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    });

    ws.on('error', (e) => {
        console.error('WS Error:', e);
        ws.close();
    });

    ws.on('close', () => {
        if (ctx.ws === ws) ctx.ws = null;

        // Clear all pending RPC promises immediately on disconnect
        for (const [id, resolver] of ctx.pendingRequests.entries()) {
            ctx.pendingRequests.delete(id);
            resolver({ error: { code: -1, message: 'Connection closed' } });
        }
        
        // Clear subscription mappings (will be re-established on reconnect)
        ctx.subscriptionIds.clear();
        
        // Cleanup expired quotes from cache (keep cache for potential late quote_status)
        const now = Date.now();
        for (const [hash, quote] of ctx.quoteCache.entries()) {
            if (now > quote.deadlineMs + 60000) { // Expired + 60s buffer
                ctx.quoteCache.delete(hash);
            }
        }

        console.log('WS Closed');
        reconnectAttempts++;
        connectToBusWithRetry(ctx, quoterService, hedgerService, nearService, hlService, inventoryManager, logger);
    });
}

main().catch(console.error);
