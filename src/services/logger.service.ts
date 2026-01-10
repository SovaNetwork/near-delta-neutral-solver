import * as fs from 'fs';
import * as path from 'path';

export type TradeEventType = 
    | 'QUOTE_GENERATED' 
    | 'QUOTE_PUBLISHED' 
    | 'QUOTE_REJECTED' 
    | 'SETTLEMENT_DETECTED' 
    | 'HEDGE_EXECUTED' 
    | 'HEDGE_FAILED' 
    | 'QUOTE_EXPIRED'
    | 'QUOTE_WON'
    | 'QUOTE_LOST'
    | 'POSITION_UPDATE'
    | 'RISK_ALERT'
    | 'EMERGENCY_MODE_CHANGE';

export interface TradeEvent {
    timestamp: string;
    type: TradeEventType;
    nonce?: string;
    traceId?: string;
    direction?: 'buy' | 'sell' | 'long' | 'short';
    amountBtc?: number;
    amountUsdt?: number;
    quotedPrice?: number;
    executionPrice?: number;
    spreadBps?: number;
    reason?: string;
    timings?: { quote: number; sign: number; post: number; total: number };
    error?: string;
    pnlUsd?: number;
    [key: string]: any;
}

// Helper to create short quote IDs for readable logs
export function shortId(nonce: string): string {
    return nonce.slice(0, 8);
}

// Console formatting utilities for readable logs
export const ConsoleFormat = {
    // Format a trade event for console output
    trade(event: Partial<TradeEvent>): string {
        const id = event.nonce ? `[${shortId(event.nonce)}]` : '';
        const dir = event.direction?.toUpperCase() || '';
        const btc = event.amountBtc?.toFixed(6) || '';
        const price = event.quotedPrice ? `@ $${event.quotedPrice.toFixed(2)}` : '';
        const spread = event.spreadBps ? `spread:${event.spreadBps.toFixed(1)}bps` : '';
        const pnl = event.pnlUsd !== undefined ? `P&L:$${event.pnlUsd >= 0 ? '+' : ''}${event.pnlUsd.toFixed(2)}` : '';
        
        return `${id} ${dir} ${btc} BTC ${price} ${spread} ${pnl}`.trim().replace(/\s+/g, ' ');
    },

    // Format position summary
    position(spotBtc: number, perpPos: number, netDelta: number, margin: number): string {
        const deltaStatus = Math.abs(netDelta) < 0.001 ? '✅' : '⚠️';
        return `${deltaStatus} Spot:${spotBtc.toFixed(6)} Perp:${perpPos.toFixed(6)} Δ:${netDelta.toFixed(6)} Margin:$${margin.toFixed(2)}`;
    },

    // Format timing info
    timing(timings: { quote?: number; sign?: number; post?: number; total?: number }): string {
        const parts = [];
        if (timings.total !== undefined) parts.push(`total:${timings.total.toFixed(0)}ms`);
        if (timings.quote !== undefined) parts.push(`quote:${timings.quote.toFixed(0)}ms`);
        if (timings.sign !== undefined) parts.push(`sign:${timings.sign.toFixed(0)}ms`);
        if (timings.post !== undefined) parts.push(`net:${timings.post.toFixed(0)}ms`);
        return parts.join(' ');
    },

    // Format price with spread indicator
    price(quotePrice: number, hedgePrice?: number, direction?: string): string {
        if (!hedgePrice) return `$${quotePrice.toFixed(2)}`;
        const diff = hedgePrice - quotePrice;
        const bps = (diff / quotePrice) * 10000;
        const arrow = diff >= 0 ? '↑' : '↓';
        return `$${quotePrice.toFixed(2)} → $${hedgePrice.toFixed(2)} (${arrow}${Math.abs(bps).toFixed(1)}bps)`;
    },

    // Status symbols
    symbols: {
        success: '✅',
        failure: '❌',
        pending: '🔄',
        expired: '⏰',
        warning: '⚠️',
        buy: '📥',
        sell: '📤',
        hedge: '🛡️',
        settlement: '💰',
        emergency: '🚨'
    }
};

export interface PositionSnapshot {
    timestamp: string;
    spotBtc: number;
    spotUsdt: number;
    perpPosition: number;
    netDelta: number;
    availableMargin: number;
}

export class LoggerService {
    private logsDir: string;
    private tradesFile: string;
    private positionsFile: string;

    constructor() {
        // Use LOGS_DIR env var for Railway volume mount, default to ./logs for local
        this.logsDir = process.env.LOGS_DIR || path.join(process.cwd(), 'logs');
        this.tradesFile = path.join(this.logsDir, 'trades.jsonl');
        this.positionsFile = path.join(this.logsDir, 'positions.jsonl');

        this.ensureLogsDir();
        console.log(`LoggerService initialized. Logs dir: ${this.logsDir}`);
    }

    private ensureLogsDir() {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    logTrade(event: Omit<TradeEvent, 'timestamp'>) {
        const entry: TradeEvent = {
            timestamp: new Date().toISOString(),
            ...event
        } as TradeEvent;
        this.appendToFile(this.tradesFile, entry);
    }

    logPosition(snapshot: Omit<PositionSnapshot, 'timestamp'>) {
        const entry: PositionSnapshot = {
            timestamp: new Date().toISOString(),
            ...snapshot
        };
        this.appendToFile(this.positionsFile, entry);
    }

    private appendToFile(filePath: string, data: any) {
        try {
            fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
        } catch (e) {
            console.error(`Failed to write to log file ${filePath}:`, e);
        }
    }

    getTrades(limit: number = 100): TradeEvent[] {
        return this.readLastLines(this.tradesFile, limit);
    }

    getPositions(limit: number = 100): PositionSnapshot[] {
        return this.readLastLines(this.positionsFile, limit);
    }

    // Helper to read last N lines (inefficient for huge files but ok for now)
    private readLastLines(filePath: string, limit: number): any[] {
        try {
            if (!fs.existsSync(filePath)) return [];
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.trim().split('\n');
            const lastLines = lines.slice(-limit);
            return lastLines.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            }).filter(x => x !== null);
        } catch (e) {
            console.error(`Error reading log file ${filePath}:`, e);
            return [];
        }
    }

    getStats(hours: number = 24) {
        const trades = this.getTrades(1000); // Get last 1000 events
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).getTime();

        const recentTrades = trades.filter(t => new Date(t.timestamp).getTime() > cutoff);

        const published = recentTrades.filter(t => t.type === 'QUOTE_PUBLISHED').length;
        const rejected = recentTrades.filter(t => t.type === 'QUOTE_REJECTED').length;

        return {
            quotesGenerated: recentTrades.filter(t => t.type === 'QUOTE_GENERATED').length,
            quotesPublished: published,
            quotesRejected: rejected,
            winRate: published + rejected > 0 ? ((published / (published + rejected)) * 100).toFixed(1) + '%' : 'N/A',
            hedgesExecuted: recentTrades.filter(t => t.type === 'HEDGE_EXECUTED').length,
            failures: recentTrades.filter(t => t.type === 'HEDGE_FAILED').length,
            volumeBtc: recentTrades
                .filter(t => t.type === 'HEDGE_EXECUTED')
                .reduce((acc, t) => acc + (t.amountBtc || 0), 0)
        };
    }
}
