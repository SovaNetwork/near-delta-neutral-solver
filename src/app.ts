import { NearService } from './services/near.service';
import { HyperliquidService } from './services/hyperliquid.service';
import { InventoryStateService } from './services/inventory-manager.service';
import { QuoterService } from './services/quoter.service';
import { HedgerService } from './services/hedger.service';
import { CronService } from './services/cron.service';
import { LoggerService } from './services/logger.service';
import { ApiService } from './services/api.service';
import { BTC_ONLY_CONFIG } from './configs/btc-only.config';
import WebSocket from 'ws';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import * as http from 'http';
import * as https from 'https';

dotenv.config();

const SOLVER_BUS_WS = process.env.SOLVER_BUS_WS_URL || 'wss://solver-relay-v2.chaindefuser.com/ws';
const SOLVER_BUS_RPC = process.env.SOLVER_BUS_RPC_URL || 'https://solver-relay-v2.chaindefuser.com/rpc';

// Create axios instance with HTTP keep-alive for connection reuse
const axiosInstance = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000 }),
    httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000 }),
    timeout: 10000,
    headers: {
        'Connection': 'keep-alive'
    }
});

// Global retry state for simplicity
let reconnectAttempts = 0;

// Context to share mutable WebSocket reference
interface SolverContext {
    ws: WebSocket | null;
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
    const hedgerService = new HedgerService(nearService, hlService, logger);
    const cronService = new CronService(nearService, hlService, logger);
    const apiService = new ApiService(hedgerService, hlService, nearService, logger, port);

    hedgerService.start();
    cronService.start();
    apiService.start();

    // Pre-warm caches to make first quotes fast
    console.log("Pre-warming caches...");
    const warmCaches = async () => {
        try {
            await Promise.all([
                inventoryManager.getQuoteDirection(),
                hlService.getAvailableMargin(),
                hlService.getBtcPosition(),
                hlService.getFundingRate()
            ]);
        } catch (e) {
            console.warn("Cache warming failed:", e);
        }
    };

    await warmCaches();
    console.log("Caches pre-warmed successfully.");

    // Keep caches warm with periodic refresh every 15 seconds
    const cacheWarmerInterval = setInterval(() => {
        warmCaches(); // Run in background, don't await
    }, 15000);

    const ctx: SolverContext = { ws: null };

    // Graceful Shutdown
    // Registered ONCE here to avoid memory leaks on reconnection
    const cleanup = () => {
        console.log("Shutting down...");
        if (ctx.ws) {
            ctx.ws.close();
            console.log("WebSocket closed.");
        }
        clearInterval(cacheWarmerInterval);
        hedgerService.stop();
        cronService.stop();
        apiService.stop();
        process.exit(0);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);

    // 2. Connect to Solver Bus
    await connectToBusWithRetry(ctx, quoterService, hedgerService, nearService, logger);
}

async function connectToBusWithRetry(
    ctx: SolverContext,
    quoterService: QuoterService,
    hedgerService: HedgerService,
    nearService: NearService,
    logger: LoggerService
) {
    if (reconnectAttempts > 0) {
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
        console.log(`Reconnecting in ${delay / 1000}s (Attempt ${reconnectAttempts})...`);
        await new Promise(r => setTimeout(r, delay));
    }

    console.log(`Connecting to Solver Bus: ${SOLVER_BUS_WS}`);

    const wsOptions: any = {};
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
        ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'subscribe',
            params: ['quote']
        }));
        console.log('Subscribed to quote stream');
    });

    ws.on('message', async (data: string) => {
        const t0 = performance.now();
        try {
            const msg = JSON.parse(data.toString());

            // Handle subscription confirmation (has 'result' field)
            if (msg.result) {
                console.log('Subscription confirmed:', msg.result);
                return;
            }

            // Parse quote request: { method: "event", params: { subscription, data: { quote_id, ... } } }
            const quoteData = msg.params?.data;
            if (!quoteData || !quoteData.quote_id) return;

            const t1 = performance.now();

            // Strip nep141: prefix from token IDs
            const stripPrefix = (tokenId: string) => tokenId.replace(/^nep\d+:/, '');

            // Map defuse field names to our internal format
            const req = {
                token_in: stripPrefix(quoteData.defuse_asset_identifier_in),
                token_out: stripPrefix(quoteData.defuse_asset_identifier_out),
                amount_in: quoteData.exact_amount_in || quoteData.exact_amount_out
            };

            // Validate Token Support
            if (req.token_in !== BTC_ONLY_CONFIG.BTC_TOKEN_ID && req.token_in !== BTC_ONLY_CONFIG.USDT_TOKEN_ID) {
                return;
            }
            if (req.token_out !== BTC_ONLY_CONFIG.BTC_TOKEN_ID && req.token_out !== BTC_ONLY_CONFIG.USDT_TOKEN_ID) {
                return;
            }

            const t2 = performance.now();

            const quote = await quoterService.getQuote(req);
            const t3 = performance.now();

            if (quote) {
                const isBuyingBtc = req.token_in === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
                const decimals = isBuyingBtc ? 8 : 6;
                const amountInFloat = parseFloat(req.amount_in) / Math.pow(10, decimals);
                const amountOutFloat = parseFloat(quote.amount_out) / (isBuyingBtc ? 1e6 : 1e8);

                // Generate Nonce - use base64 format for NEAR
                const nonce = randomBytes(32).toString('base64');

                let amountBtcForHedge = 0;
                if (isBuyingBtc) {
                    amountBtcForHedge = amountInFloat;
                } else {
                    // Output is BTC.
                    amountBtcForHedge = parseFloat(quote.amount_out) / 1e8;
                }

                hedgerService.trackQuote(nonce, {
                    direction: isBuyingBtc ? 'short' : 'long', // If we Buy BTC, we Hedge Short.
                    amountBtc: amountBtcForHedge,
                    quoteId: nonce
                });

                // Sign Payload
                const messageToSign = `${nonce}:${quote.amount_out}`;

                // Validate payload before signing
                if (messageToSign.length < 10) {
                    console.error("Invalid payload to sign");
                    return;
                }

                const t4 = performance.now();
                const signature = await nearService.sign(messageToSign);
                const t5 = performance.now();

                // Publish
                try {
                    await axiosInstance.post(SOLVER_BUS_RPC, {
                        jsonrpc: "2.0",
                        id: Date.now(),
                        method: 'submit_quote',
                        params: {
                            quote_output: quote.amount_out,
                            nonce: nonce,
                            signature: signature
                        }
                    });
                    const t6 = performance.now();

                    const timings = {
                        parse: (t1 - t0).toFixed(2),
                        validate: (t2 - t1).toFixed(2),
                        getQuote: (t3 - t2).toFixed(2),
                        sign: (t5 - t4).toFixed(2),
                        post: (t6 - t5).toFixed(2),
                        total: (t6 - t0).toFixed(2)
                    };
                    console.log(`✅ Quote Published | ${isBuyingBtc ? 'BUY' : 'SELL'} ${amountInFloat.toFixed(6)} → ${amountOutFloat.toFixed(6)} | ⏱️ ${timings.total}ms (quote:${timings.getQuote}ms sign:${timings.sign}ms post:${timings.post}ms)`);

                    logger.logTrade({
                        type: 'QUOTE_PUBLISHED',
                        nonce,
                        direction: isBuyingBtc ? 'buy' : 'sell',
                        amountBtc: amountBtcForHedge,
                        quotedPrice: 0
                    });

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
        // Only retry if not shutting down? 
        // We can just rely on reconnectAttempts logic.
        // Also clear ctx.ws
        if (ctx.ws === ws) ctx.ws = null;

        console.log('WS Closed');
        reconnectAttempts++;
        connectToBusWithRetry(ctx, quoterService, hedgerService, nearService, logger);
    });
}

main().catch(console.error);
