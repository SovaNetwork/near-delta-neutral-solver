import express from 'express';
import * as path from 'path';
import { HedgerService } from './hedger.service';
import { HyperliquidService } from './hyperliquid.service';
import { NearService } from './near.service';
import { LoggerService } from './logger.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

export class ApiService {
    private app: express.Application;
    private logger: LoggerService;
    private port: number;
    private server: any;

    constructor(
        private hedger: HedgerService,
        private hlService: HyperliquidService,
        private nearService: NearService,
        logger: LoggerService,
        port: number
    ) {
        this.logger = logger;
        this.port = port || 3000;
        this.app = express();

        this.setupRoutes();
    }

    private setupRoutes() {
        // Serve static dashboard
        this.app.use(express.static(path.join(process.cwd(), 'public')));

        // Health Check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', uptime: process.uptime() });
        });

        // Positions & Status
        this.app.get('/api/positions', async (req, res) => {
            try {
                const spotBtcBN = await this.nearService.getBalance(BTC_ONLY_CONFIG.BTC_TOKEN_ID);
                const spotUsdtBN = await this.nearService.getBalance(BTC_ONLY_CONFIG.USDT_TOKEN_ID);

                const spotBtc = spotBtcBN.div(1e8).toNumber();
                const spotUsdt = spotUsdtBN.div(1e6).toNumber();
                const perpPos = await this.hlService.getBtcPosition();
                const availableMargin = await this.hlService.getAvailableMargin();

                const netDelta = spotBtc + perpPos;

                // Parse token symbols from token IDs
                const btcTokenId = BTC_ONLY_CONFIG.BTC_TOKEN_ID;
                const usdtTokenId = BTC_ONLY_CONFIG.USDT_TOKEN_ID;

                // Extract readable names
                let btcSymbol = 'BTC';
                if (btcTokenId.includes('cbbtc') || btcTokenId.includes('cbb7c0000ab88b473b1f5afd9ef808440eed33bf')) {
                    btcSymbol = 'cbBTC';
                } else if (btcTokenId.includes('2260fac5e5542a773aa44fbcfedf7c193bc2c599')) {
                    btcSymbol = 'wBTC';
                } else if (btcTokenId === 'btc.omft.near') {
                    btcSymbol = 'BTC';
                }

                const snapshot = {
                    // NEAR Intents balances
                    nearIntents: {
                        btc: spotBtc,
                        btcSymbol,
                        btcTokenId,
                        usdt: spotUsdt,
                        usdtTokenId
                    },
                    // Hyperliquid positions
                    hyperliquid: {
                        perpPosition: perpPos,
                        availableMargin
                    },
                    // Computed
                    netDelta,
                    // Legacy fields for backwards compat
                    spotBtc,
                    spotUsdt,
                    perpPosition: perpPos,
                    availableMargin,
                    timestamp: new Date().toISOString()
                };

                res.json(snapshot);
            } catch (e) {
                res.status(500).json({ error: String(e) });
            }
        });

        // Pending Quotes
        this.app.get('/api/pending-quotes', (req, res) => {
            res.json(this.hedger.getPendingQuotes());
        });

        // Trades History
        this.app.get('/api/trades', (req, res) => {
            const limit = parseInt(req.query.limit as string) || 100;
            res.json(this.logger.getTrades(limit));
        });

        // Stats
        this.app.get('/api/stats', (req, res) => {
            const hours = parseInt(req.query.hours as string) || 24;
            res.json(this.logger.getStats(hours));
        });

        // Config (expose relevant settings for dashboard)
        this.app.get('/api/config', (req, res) => {
            res.json({
                maxBtcInventory: BTC_ONLY_CONFIG.MAX_BTC_INVENTORY,
                minUsdtReserve: BTC_ONLY_CONFIG.MIN_USDT_RESERVE,
                targetSpreadBips: BTC_ONLY_CONFIG.TARGET_SPREAD_BIPS,
                minMarginThreshold: BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD,
                minHourlyFundingRate: BTC_ONLY_CONFIG.MIN_HOURLY_FUNDING_RATE,
                driftThresholdBtc: BTC_ONLY_CONFIG.DRIFT_THRESHOLD_BTC,
                minTradeSizeBtc: BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC,
                maxTradeSizeBtc: BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC
            });
        });

        // Metrics (Prometheus format)
        this.app.get('/metrics', async (req, res) => {
            try {
                const stats = this.logger.getStats(24);
                const pending = this.hedger.getPendingQuotes().length;

                const response = [
                    `# HELP near_solver_quotes_generated_24h Total quotes generated in last 24h`,
                    `near_solver_quotes_generated_24h ${stats.quotesGenerated}`,
                    `# HELP near_solver_hedges_executed_24h Total hedges executed in last 24h`,
                    `near_solver_hedges_executed_24h ${stats.hedgesExecuted}`,
                    `# HELP near_solver_hedge_failures_24h Total hedge failures in last 24h`,
                    `near_solver_hedge_failures_24h ${stats.failures}`,
                    `# HELP near_solver_volume_btc_24h Total volume in BTC in last 24h`,
                    `near_solver_volume_btc_24h ${stats.volumeBtc.toFixed(8)}`,
                    `# HELP near_solver_pending_quotes Current number of pending quotes`,
                    `near_solver_pending_quotes ${pending}`
                ].join('\n');

                res.set('Content-Type', 'text/plain');
                res.send(response);
            } catch (e) {
                res.status(500).send(String(e));
            }
        });

        // CSV Export
        this.app.get('/api/export/trades.csv', (req, res) => {
            const trades = this.logger.getTrades(10000);
            const header = 'timestamp,type,nonce,direction,amountBtc,amountUsdt,quotedPrice,executionPrice,error\n';
            const rows = trades.map(t => {
                return [
                    t.timestamp,
                    t.type,
                    t.nonce || '',
                    t.direction || '',
                    t.amountBtc || '',
                    t.amountUsdt || '',
                    t.quotedPrice || '',
                    t.executionPrice || '',
                    t.error ? `"${t.error.replace(/"/g, '""')}"` : ''
                ].join(',');
            }).join('\n');

            res.set('Content-Type', 'text/csv');
            res.attachment('trades.csv');
            res.send(header + rows);
        });
    }

    start() {
        this.server = this.app.listen(this.port, () => {
            console.log(`API Server running on http://localhost:${this.port}`);
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            console.log('API Server stopped.');
        }
    }
}
