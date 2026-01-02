import { NearService } from './services/near.service';
import { HyperliquidService } from './services/hyperliquid.service';
import { InventoryStateService } from './services/inventory-manager.service';
import { QuoterService } from './services/quoter.service';
import { HedgerService } from './services/hedger.service';
import { CronService } from './services/cron.service';
import { BTC_ONLY_CONFIG } from './configs/btc-only.config';
import WebSocket from 'ws';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { randomBytes } from 'crypto';

dotenv.config();

const SOLVER_BUS_WS = process.env.SOLVER_BUS_WS_URL || 'wss://solver-relay-v2.chaindefuser.com/ws';
const SOLVER_BUS_RPC = process.env.SOLVER_BUS_RPC_URL || 'https://solver-relay-v2.chaindefuser.com/rpc';

async function main() {
    console.log("Starting Delta-Neutral Solver...");

    // 1. Init Services
    const nearService = new NearService();
    await nearService.init();

    const hlService = new HyperliquidService();
    await hlService.init();

    const inventoryManager = new InventoryStateService(nearService, hlService);
    const quoterService = new QuoterService(inventoryManager, hlService, nearService);
    const hedgerService = new HedgerService(nearService, hlService);
    const cronService = new CronService(nearService, hlService);

    hedgerService.start();
    cronService.start();

    // 2. Connect to Solver Bus
    console.log(`Connecting to Solver Bus: ${SOLVER_BUS_WS}`);
    const ws = new WebSocket(SOLVER_BUS_WS);

    ws.on('open', () => {
        console.log('Connected to Solver Bus');
        ws.send(JSON.stringify({ method: 'subscribe', topic: 'quote_request' }));
    });

    ws.on('message', async (data: string) => {
        try {
            const msg = JSON.parse(data.toString());
            // Filter heartbeats or other messages
            if (!msg.type || msg.type !== 'quote_request' || !msg.payload) return;

            const req = msg.payload;
            // console.log(`Received RFQ: ${req.amount_in} ${req.token_in}`);

            const quote = await quoterService.getQuote(req);

            if (quote) {
                console.log(`Generated Quote for ${req.amount_in}: Out ${quote.amount_out}`);

                // Generate Nonce (Mocking intent expectation)
                const nonce = '0x' + randomBytes(32).toString('hex');

                // Determine direction
                const isBuyingBtc = req.token_in === BTC_ONLY_CONFIG.BTC_TOKEN_ID;
                const decimals = isBuyingBtc ? 8 : 6;
                const amountInFloat = parseFloat(req.amount_in) / Math.pow(10, decimals);
                // If buying BTC, amountIn is strict BTC. If selling BTC (Buying USDC), amountIn is USDC.
                // Hedger needs BTC amount.
                // If isBuyingBtc (User Sell BTC), amountBtc = amountIn.
                // If !isBuyingBtc (User Buy BTC), amountBtc = amountOut (from quote, which is strictly BTC amount if out is BTC?).

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

                // Publish
                try {
                    await axios.post(SOLVER_BUS_RPC, {
                        jsonrpc: "2.0",
                        id: Date.now(),
                        method: 'submit_quote',
                        params: {
                            quote_output: quote.amount_out,
                            nonce: nonce,
                            signature: quote.signature // Mocked
                        }
                    });
                    console.log("Quote Published");
                } catch (postErr) {
                    console.error("Failed to publish quote:", postErr);
                }
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    });

    ws.on('error', (e) => console.error('WS Error:', e));
    ws.on('close', () => console.log('WS Closed'));
}

main().catch(console.error);
