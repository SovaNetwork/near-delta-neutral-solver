import express from 'express';
import * as path from 'path';
import { HedgerService } from './hedger.service';
import { HyperliquidService } from './hyperliquid.service';
import { NearService } from './near.service';
import { LoggerService } from './logger.service';
import { TraceService } from './trace.service';
import { InventoryStateService } from './inventory-manager.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

export class ApiService {
    private app: express.Application;
    private logger: LoggerService;
    private traceService: TraceService;
    private port: number;
    private server: any;

    constructor(
        private hedger: HedgerService,
        private hlService: HyperliquidService,
        private nearService: NearService,
        logger: LoggerService,
        port: number,
        traceService?: TraceService,
        private inventoryManager?: InventoryStateService
    ) {
        this.logger = logger;
        this.traceService = traceService || new TraceService();
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
                // Fetch all BTC token balances in parallel using config
                const btcBalancePromises = BTC_ONLY_CONFIG.BTC_TOKENS.map(async token => {
                    const balBN = await this.nearService.getBalance(token.id);
                    return {
                        tokenId: token.id,
                        symbol: token.symbol,
                        balance: balBN.div(Math.pow(10, token.decimals)).toNumber()
                    };
                });

                // Fetch all USD stablecoin balances in parallel
                const usdBalancePromises = BTC_ONLY_CONFIG.USD_TOKENS.map(async token => {
                    const balBN = await this.nearService.getBalance(token.id);
                    return {
                        tokenId: token.id,
                        symbol: token.symbol,
                        balance: balBN.div(Math.pow(10, token.decimals)).toNumber()
                    };
                });

                const [btcBalances, usdBalances, perpPos, availableMargin] = await Promise.all([
                    Promise.all(btcBalancePromises),
                    Promise.all(usdBalancePromises),
                    this.hlService.getBtcPosition(),
                    this.hlService.getAvailableMargin()
                ]);

                const totalSpotBtc = btcBalances.reduce((sum, b) => sum + b.balance, 0);
                const totalSpotUsd = usdBalances.reduce((sum, b) => sum + b.balance, 0);
                const netDelta = totalSpotBtc + perpPos;

                const snapshot = {
                    // NEAR Intents balances - multi-token support
                    nearIntents: {
                        btcBalances,
                        totalBtc: totalSpotBtc,
                        usdBalances,
                        totalUsd: totalSpotUsd,
                    },
                    // Hyperliquid positions
                    hyperliquid: {
                        perpPosition: perpPos,
                        availableMargin
                    },
                    // Computed
                    netDelta,
                    // Legacy fields for backwards compat
                    spotBtc: totalSpotBtc,
                    spotUsdt: totalSpotUsd,
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
                maxNegativeFundingRate: BTC_ONLY_CONFIG.MAX_NEGATIVE_FUNDING_RATE,
                driftThresholdBtc: BTC_ONLY_CONFIG.DRIFT_THRESHOLD_BTC,
                minTradeSizeBtc: BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC,
                maxTradeSizeBtc: BTC_ONLY_CONFIG.MAX_TRADE_SIZE_BTC
            });
        });

        // Market data (Hyperliquid orderbook + funding)
        this.app.get('/api/market', async (req, res) => {
            try {
                const orderbook = this.hlService.getOrderbookSummary();
                const fundingRate = await this.hlService.getFundingRate();

                res.json({
                    orderbook,
                    funding: {
                        rate: fundingRate,
                        ratePercent: (fundingRate * 100).toFixed(4) + '%',
                        annualized: ((fundingRate * 24 * 365) * 100).toFixed(2) + '%'
                    },
                    timestamp: new Date().toISOString()
                });
            } catch (e) {
                res.status(500).json({ error: String(e) });
            }
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

        // ===== ENHANCED TRACING & POSITION VISIBILITY ENDPOINTS =====

        // Active trade traces (trades in progress)
        this.app.get('/api/traces/active', (req, res) => {
            res.json(this.traceService.getActiveTraces());
        });

        // Completed trade traces
        this.app.get('/api/traces/completed', (req, res) => {
            const limit = parseInt(req.query.limit as string) || 100;
            res.json(this.traceService.getCompletedTrades(limit));
        });

        // Get specific trade by nonce
        this.app.get('/api/traces/:nonce', (req, res) => {
            const trade = this.traceService.getTradeByNonce(req.params.nonce);
            if (trade) {
                res.json(trade);
            } else {
                res.status(404).json({ error: 'Trade not found' });
            }
        });

        // Performance metrics (P&L, win rate, volume)
        this.app.get('/api/performance', (req, res) => {
            const hours = parseInt(req.query.hours as string) || 24;
            res.json(this.traceService.getPerformanceMetrics(hours));
        });

        // P&L history
        this.app.get('/api/pnl', (req, res) => {
            const limit = parseInt(req.query.limit as string) || 50;
            res.json(this.traceService.getRecentPnl(limit));
        });

        // Comprehensive position snapshot with P&L context
        this.app.get('/api/position-summary', async (req, res) => {
            try {
                // Fetch all balances in parallel
                const btcBalancePromises = BTC_ONLY_CONFIG.BTC_TOKENS.map(async token => {
                    const balBN = await this.nearService.getBalance(token.id);
                    return {
                        tokenId: token.id,
                        symbol: token.symbol,
                        balance: balBN.div(Math.pow(10, token.decimals)).toNumber()
                    };
                });

                const usdBalancePromises = BTC_ONLY_CONFIG.USD_TOKENS.map(async token => {
                    const balBN = await this.nearService.getBalance(token.id);
                    return {
                        tokenId: token.id,
                        symbol: token.symbol,
                        balance: balBN.div(Math.pow(10, token.decimals)).toNumber()
                    };
                });

                const [btcBalances, usdBalances, perpPos, availableMargin, fundingRate] = await Promise.all([
                    Promise.all(btcBalancePromises),
                    Promise.all(usdBalancePromises),
                    this.hlService.getBtcPosition(),
                    this.hlService.getAvailableMargin(),
                    this.hlService.getFundingRate()
                ]);

                const totalSpotBtc = btcBalances.reduce((sum, b) => sum + b.balance, 0);
                const totalSpotUsd = usdBalances.reduce((sum, b) => sum + b.balance, 0);
                const netDelta = totalSpotBtc + perpPos;

                // Get orderbook for pricing
                const orderbook = this.hlService.getOrderbookSummary();
                const btcPrice = orderbook?.midPrice || 0;
                const spotBtcValueUsd = totalSpotBtc * btcPrice;

                // Performance metrics
                const metrics = this.traceService.getPerformanceMetrics(24);

                res.json({
                    timestamp: new Date().toISOString(),
                    positions: {
                        spot: {
                            btc: {
                                total: totalSpotBtc,
                                valueUsd: spotBtcValueUsd,
                                breakdown: btcBalances
                            },
                            usd: {
                                total: totalSpotUsd,
                                breakdown: usdBalances
                            }
                        },
                        perp: {
                            positionBtc: perpPos,
                            valueUsd: Math.abs(perpPos) * btcPrice,
                            side: perpPos > 0 ? 'LONG' : perpPos < 0 ? 'SHORT' : 'FLAT'
                        },
                        netDeltaBtc: netDelta,
                        netDeltaUsd: netDelta * btcPrice,
                        isDeltaNeutral: Math.abs(netDelta) < BTC_ONLY_CONFIG.DRIFT_THRESHOLD_BTC
                    },
                    health: {
                        availableMargin,
                        fundingRate,
                        fundingRateAnnualized: (fundingRate * 24 * 365 * 100).toFixed(2) + '%',
                        btcPrice,
                        emergencyMode: this.inventoryManager?.isEmergencyMode() ?? false
                    },
                    performance24h: metrics,
                    pendingTrades: this.hedger.getPendingQuotes().length,
                    activeTrades: this.traceService.getActiveTraces().length
                });
            } catch (e) {
                res.status(500).json({ error: String(e) });
            }
        });

        // Audit trail for a specific trade
        this.app.get('/api/audit/:nonce', (req, res) => {
            const trade = this.traceService.getTradeByNonce(req.params.nonce);
            if (!trade) {
                res.status(404).json({ error: 'Trade not found' });
                return;
            }

            // Build audit trail with all phases
            const audit = {
                traceId: trade.traceId,
                nonce: trade.nonce,
                summary: {
                    direction: trade.direction,
                    btcAmount: trade.btcAmount,
                    usdAmount: trade.usdAmount,
                    quotedPrice: trade.quotedPrice,
                    hedgePrice: trade.hedgePrice,
                    spreadBps: trade.spreadBps,
                    status: trade.status,
                    realizedPnlUsd: trade.realizedPnlUsd
                },
                timing: {
                    startTime: new Date(trade.startTime).toISOString(),
                    endTime: trade.endTime ? new Date(trade.endTime).toISOString() : null,
                    durationMs: trade.endTime ? trade.endTime - trade.startTime : null
                },
                phases: trade.phases.map(p => ({
                    timestamp: p.timestamp,
                    phase: p.phase,
                    durationFromStartMs: p.durationMs,
                    data: p.data
                }))
            };

            res.json(audit);
        });

        // Export P&L as CSV
        this.app.get('/api/export/pnl.csv', (req, res) => {
            const pnl = this.traceService.getRecentPnl(10000);
            const header = 'timestamp,traceId,nonce,direction,btcAmount,quotedPrice,hedgePrice,spreadBps,realizedPnlUsd,latencyMs\n';
            const rows = pnl.map(p => [
                p.timestamp,
                p.traceId,
                p.nonce,
                p.direction,
                p.btcAmount,
                p.quotedPrice,
                p.hedgePrice || '',
                p.spreadBps,
                p.realizedPnlUsd || '',
                p.latencyMs || ''
            ].join(',')).join('\n');

            res.set('Content-Type', 'text/csv');
            res.attachment('pnl.csv');
            res.send(header + rows);
        });
    }

    getTraceService(): TraceService {
        return this.traceService;
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
