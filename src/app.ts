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

dotenv.config();

const SOLVER_BUS_WS = process.env.SOLVER_BUS_WS_URL || 'wss://solver-relay-v2.chaindefuser.com/ws';
const SOLVER_BUS_RPC = process.env.SOLVER_BUS_RPC_URL || 'https://solver-relay-v2.chaindefuser.com/rpc';

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
    const port = process.env.PORT ? parseInt(process.env.PORT) : (parseInt(process.env.API_PORT || '3000'));

    const inventoryManager = new InventoryStateService(nearService, hlService);
    const quoterService = new QuoterService(inventoryManager, hlService, nearService, logger);
    const hedgerService = new HedgerService(nearService, hlService, logger);
    const cronService = new CronService(nearService, hlService, logger);
    const apiService = new ApiService(hedgerService, hlService, nearService, logger, port);

    hedgerService.start();
    cronService.start();
    apiService.start();

    const ctx: SolverContext = { ws: null };

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
        ws.send(JSON.stringify({ method: 'subscribe', topic: 'quote_request' }));
    });

    ws.on('message', async (data: string) => {
        try {
            const msg = JSON.parse(data.toString());
            // Filter heartbeats or other messages
            if (!msg.type || msg.type !== 'quote_request' || !msg.payload) return;

            const req = msg.payload;

            // Validate Token Support
            if (req.token_in !== BTC_ONLY_CONFIG.BTC_TOKEN_ID && req.token_in !== BTC_ONLY_CONFIG.USDT_TOKEN_ID) {
                return;
            }

            const quote = await quoterService.getQuote(req);

            if (quote) {
                console.log(`Generated Quote for ${req.amount_in}: Out ${quote.amount_out}`);

                // Generate Nonce (Mocking intent expectation)
                const nonce = '0x' + randomBytes(32).toString('hex');

                // Determine direction
                const isBuyingBtc = req.token_in === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
                const decimals = isBuyingBtc ? 8 : 6;
                const amountInFloat = parseFloat(req.amount_in) / Math.pow(10, decimals);

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

                const signature = await nearService.sign(messageToSign);

                // Publish
                try {
                    await axios.post(SOLVER_BUS_RPC, {
                        jsonrpc: "2.0",
                        id: Date.now(),
                        method: 'submit_quote',
                        params: {
                            quote_output: quote.amount_out,
                            nonce: nonce,
                            signature: signature
                        }
                    });
                    console.log("Quote Published");

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
