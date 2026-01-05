import * as fs from 'fs';
import * as path from 'path';

export interface TradeEvent {
    timestamp: string;
    type: 'QUOTE_GENERATED' | 'QUOTE_PUBLISHED' | 'SETTLEMENT_DETECTED' | 'HEDGE_EXECUTED' | 'HEDGE_FAILED' | 'QUOTE_EXPIRED';
    nonce?: string;
    direction?: 'buy' | 'sell' | 'long' | 'short';
    amountBtc?: number;
    amountUsdt?: number;
    quotedPrice?: number;
    executionPrice?: number;
    error?: string;
    [key: string]: any;
}

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
        this.logsDir = path.join(process.cwd(), 'logs');
        this.tradesFile = path.join(this.logsDir, 'trades.jsonl');
        this.positionsFile = path.join(this.logsDir, 'positions.jsonl');

        this.ensureLogsDir();
    }

    private ensureLogsDir() {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir);
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

        return {
            quotesGenerated: recentTrades.filter(t => t.type === 'QUOTE_GENERATED').length,
            hedgesExecuted: recentTrades.filter(t => t.type === 'HEDGE_EXECUTED').length,
            failures: recentTrades.filter(t => t.type === 'HEDGE_FAILED').length,
            volumeBtc: recentTrades
                .filter(t => t.type === 'HEDGE_EXECUTED')
                .reduce((acc, t) => acc + (t.amountBtc || 0), 0)
        };
    }
}
