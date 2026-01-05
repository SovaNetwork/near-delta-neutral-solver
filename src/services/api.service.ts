import express from 'express';
import * as path from 'path';
import { HedgerService } from './hedger.service';
import { HyperliquidService } from './hyperliquid.service';
import { NearService } from './near.service';
import { LoggerService } from './logger.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

export class ApiService {
    private app: express.Application;
    private port: number;
    private server: any;

    constructor(
        private hedger: HedgerService,
        private hlService: HyperliquidService,
        private nearService: NearService,
        private logger: LoggerService
    ) {
        this.app = express();
        this.port = parseInt(process.env.API_PORT || '3000');

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

                // Assuming margin info isn't easily available in current HL service, 
                // we'll just return what we have.
                // Todo: Add getMargin() to HL service if needed.

                const netDelta = spotBtc + perpPos;

                const snapshot = {
                    spotBtc,
                    spotUsdt,
                    perpPosition: perpPos,
                    netDelta,
                    availableMargin,
                    timestamp: new Date().toISOString()
                };

                // Log snapshot asynchronously? Or just return it.
                // The CronService logs it periodically, so maybe we don't need to log every API call.

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
