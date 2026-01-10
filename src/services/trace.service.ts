import * as fs from 'fs';
import * as path from 'path';

export type TradePhase = 
    | 'QUOTE_RECEIVED'
    | 'QUOTE_VALIDATED' 
    | 'QUOTE_PRICED'
    | 'QUOTE_SIGNED'
    | 'QUOTE_PUBLISHED'
    | 'QUOTE_REJECTED'
    | 'QUOTE_WON'
    | 'QUOTE_LOST'
    | 'SETTLEMENT_DETECTED'
    | 'HEDGE_STARTED'
    | 'HEDGE_EXECUTED'
    | 'HEDGE_FAILED'
    | 'QUOTE_EXPIRED';

export interface TraceEvent {
    timestamp: string;
    traceId: string;
    phase: TradePhase;
    durationMs?: number;
    data?: Record<string, any> | undefined;
}

export interface CompletedTrade {
    traceId: string;
    nonce: string;
    direction: 'BUY' | 'SELL';
    btcAmount: number;
    usdAmount: number;
    quotedPrice: number;
    hedgePrice?: number;
    spreadBps: number;
    realizedPnlUsd?: number;
    startTime: number;
    endTime?: number;
    status: 'won' | 'lost' | 'expired' | 'failed';
    phases: TraceEvent[];
}

export interface PositionSummary {
    timestamp: string;
    spotBtc: number;
    spotUsd: number;
    perpPositionBtc: number;
    perpUnrealizedPnl: number;
    netDeltaBtc: number;
    availableMargin: number;
    totalEquityUsd: number;
}

export interface PerformanceMetrics {
    periodHours: number;
    tradesWon: number;
    tradesLost: number;
    tradesExpired: number;
    winRate: number;
    totalVolumeBtc: number;
    totalVolumeUsd: number;
    realizedPnlUsd: number;
    avgSpreadBps: number;
    avgLatencyMs: number;
    hedgeSuccessRate: number;
}

export class TraceService {
    private activeTraces = new Map<string, CompletedTrade>();
    private completedTrades: CompletedTrade[] = [];
    private readonly MAX_COMPLETED_TRADES = 1000;
    private logsDir: string;
    private traceFile: string;
    private pnlFile: string;

    constructor() {
        this.logsDir = process.env.LOGS_DIR || path.join(process.cwd(), 'logs');
        this.traceFile = path.join(this.logsDir, 'traces.jsonl');
        this.pnlFile = path.join(this.logsDir, 'pnl.jsonl');
        this.ensureLogsDir();
    }

    private ensureLogsDir() {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    private generateTraceId(): string {
        return `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    startTrace(nonce: string, direction: 'BUY' | 'SELL', btcAmount: number, quotedPrice: number, spreadBps: number): string {
        const traceId = this.generateTraceId();
        const trade: CompletedTrade = {
            traceId,
            nonce,
            direction,
            btcAmount,
            usdAmount: btcAmount * quotedPrice,
            quotedPrice,
            spreadBps,
            startTime: Date.now(),
            status: 'lost',
            phases: []
        };
        
        this.activeTraces.set(nonce, trade);
        this.recordPhase(nonce, 'QUOTE_RECEIVED');
        return traceId;
    }

    recordPhase(nonce: string, phase: TradePhase, data?: Record<string, any>): void {
        const trade = this.activeTraces.get(nonce);
        if (!trade) return;

        const event: TraceEvent = {
            timestamp: new Date().toISOString(),
            traceId: trade.traceId,
            phase,
            durationMs: Date.now() - trade.startTime,
            data
        };

        trade.phases.push(event);
        this.appendToFile(this.traceFile, event);
    }

    markWon(nonce: string): void {
        const trade = this.activeTraces.get(nonce);
        if (!trade) return;
        trade.status = 'won';
        this.recordPhase(nonce, 'QUOTE_WON');
    }

    markLost(nonce: string): void {
        const trade = this.activeTraces.get(nonce);
        if (!trade) return;
        trade.status = 'lost';
        this.recordPhase(nonce, 'QUOTE_LOST');
        this.completeTrade(nonce);
    }

    recordSettlement(nonce: string): void {
        this.recordPhase(nonce, 'SETTLEMENT_DETECTED');
    }

    recordHedgeStart(nonce: string): void {
        this.recordPhase(nonce, 'HEDGE_STARTED');
    }

    recordHedgeSuccess(nonce: string, hedgePrice: number, fillQty: number): void {
        const trade = this.activeTraces.get(nonce);
        if (!trade) return;

        trade.hedgePrice = hedgePrice;
        
        // Calculate realized P&L from the spread
        // P&L = (hedge_price - quoted_price) * btc_amount for SELL
        // P&L = (quoted_price - hedge_price) * btc_amount for BUY
        const priceDiff = trade.direction === 'SELL' 
            ? hedgePrice - trade.quotedPrice 
            : trade.quotedPrice - hedgePrice;
        trade.realizedPnlUsd = priceDiff * trade.btcAmount;

        this.recordPhase(nonce, 'HEDGE_EXECUTED', {
            hedgePrice,
            fillQty,
            realizedPnlUsd: trade.realizedPnlUsd
        });

        this.completeTrade(nonce);
        this.logPnl(trade);
    }

    recordHedgeFailure(nonce: string, error: string): void {
        const trade = this.activeTraces.get(nonce);
        if (trade) {
            trade.status = 'failed';
        }
        this.recordPhase(nonce, 'HEDGE_FAILED', { error });
        this.completeTrade(nonce);
    }

    recordExpired(nonce: string): void {
        const trade = this.activeTraces.get(nonce);
        if (trade) {
            trade.status = 'expired';
        }
        this.recordPhase(nonce, 'QUOTE_EXPIRED');
        this.completeTrade(nonce);
    }

    private completeTrade(nonce: string): void {
        const trade = this.activeTraces.get(nonce);
        if (!trade) return;

        trade.endTime = Date.now();
        this.completedTrades.push(trade);
        this.activeTraces.delete(nonce);

        // Trim old trades
        if (this.completedTrades.length > this.MAX_COMPLETED_TRADES) {
            this.completedTrades = this.completedTrades.slice(-this.MAX_COMPLETED_TRADES);
        }
    }

    private logPnl(trade: CompletedTrade): void {
        const pnlEntry = {
            timestamp: new Date().toISOString(),
            traceId: trade.traceId,
            nonce: trade.nonce,
            direction: trade.direction,
            btcAmount: trade.btcAmount,
            quotedPrice: trade.quotedPrice,
            hedgePrice: trade.hedgePrice,
            spreadBps: trade.spreadBps,
            realizedPnlUsd: trade.realizedPnlUsd,
            latencyMs: trade.endTime ? trade.endTime - trade.startTime : null
        };
        this.appendToFile(this.pnlFile, pnlEntry);
    }

    private appendToFile(filePath: string, data: any): void {
        try {
            fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
        } catch (e) {
            console.error(`Failed to write to ${filePath}:`, e);
        }
    }

    getActiveTraces(): CompletedTrade[] {
        return Array.from(this.activeTraces.values());
    }

    getCompletedTrades(limit: number = 100): CompletedTrade[] {
        return this.completedTrades.slice(-limit);
    }

    getTradeByNonce(nonce: string): CompletedTrade | undefined {
        return this.activeTraces.get(nonce) || this.completedTrades.find(t => t.nonce === nonce);
    }

    getPerformanceMetrics(hours: number = 24): PerformanceMetrics {
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        const recentTrades = this.completedTrades.filter(t => t.startTime > cutoff);

        const won = recentTrades.filter(t => t.status === 'won');
        const lost = recentTrades.filter(t => t.status === 'lost');
        const expired = recentTrades.filter(t => t.status === 'expired');
        const hedged = recentTrades.filter(t => t.hedgePrice !== undefined);

        const totalVolumeBtc = won.reduce((sum, t) => sum + t.btcAmount, 0);
        const totalVolumeUsd = won.reduce((sum, t) => sum + t.usdAmount, 0);
        const realizedPnl = hedged.reduce((sum, t) => sum + (t.realizedPnlUsd || 0), 0);
        const avgSpread = won.length > 0 
            ? won.reduce((sum, t) => sum + t.spreadBps, 0) / won.length 
            : 0;
        const avgLatency = hedged.length > 0
            ? hedged.reduce((sum, t) => sum + (t.endTime! - t.startTime), 0) / hedged.length
            : 0;

        return {
            periodHours: hours,
            tradesWon: won.length,
            tradesLost: lost.length,
            tradesExpired: expired.length,
            winRate: (won.length + lost.length) > 0 
                ? (won.length / (won.length + lost.length)) * 100 
                : 0,
            totalVolumeBtc,
            totalVolumeUsd,
            realizedPnlUsd: realizedPnl,
            avgSpreadBps: avgSpread,
            avgLatencyMs: avgLatency,
            hedgeSuccessRate: won.length > 0 
                ? (hedged.length / won.length) * 100 
                : 0
        };
    }

    getRecentPnl(limit: number = 50): any[] {
        try {
            if (!fs.existsSync(this.pnlFile)) return [];
            const content = fs.readFileSync(this.pnlFile, 'utf-8');
            const lines = content.trim().split('\n');
            return lines.slice(-limit).map(line => {
                try { return JSON.parse(line); } 
                catch { return null; }
            }).filter(x => x !== null);
        } catch {
            return [];
        }
    }

    formatTradeForConsole(trade: CompletedTrade): string {
        const dirSymbol = trade.direction === 'BUY' ? '📥' : '📤';
        const statusSymbol = {
            'won': '✅',
            'lost': '❌', 
            'expired': '⏰',
            'failed': '💥'
        }[trade.status];

        const latencyMs = trade.endTime ? trade.endTime - trade.startTime : 0;
        const pnlStr = trade.realizedPnlUsd !== undefined 
            ? `$${trade.realizedPnlUsd >= 0 ? '+' : ''}${trade.realizedPnlUsd.toFixed(2)}` 
            : '';

        return `${statusSymbol} ${dirSymbol} ${trade.direction} ${trade.btcAmount.toFixed(6)} BTC @ $${trade.quotedPrice.toFixed(2)} | spread:${trade.spreadBps.toFixed(1)}bps | ${latencyMs}ms ${pnlStr}`.trim();
    }
}

export const traceService = new TraceService();
