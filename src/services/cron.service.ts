import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { LoggerService } from './logger.service';
import { InventoryStateService } from './inventory-manager.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';
import { QuoterService } from './quoter.service';

export class CronService {
    private driftInterval: NodeJS.Timeout | null = null;
    private riskRefreshInterval: NodeJS.Timeout | null = null;
    private readonly RISK_REFRESH_INTERVAL_MS = 5000;
    private quoterService: QuoterService | null = null;

    constructor(
        private nearService: NearService,
        private hlService: HyperliquidService,
        private logger: LoggerService,
        private inventoryManager: InventoryStateService
    ) {}

    setQuoterService(quoterService: QuoterService): void {
        this.quoterService = quoterService;
    }

    start() {
        this.driftInterval = setInterval(() => this.checkDrift(), 10 * 60 * 1000);
        console.log("Cron Service Started.");

        this.checkDrift();

        this.riskRefreshInterval = setInterval(() => {
            this.inventoryManager.refreshRiskSnapshot().catch(e =>
                console.warn("Background risk refresh failed:", e)
            );
        }, this.RISK_REFRESH_INTERVAL_MS);
        console.log(`Risk snapshot refresh started (every ${this.RISK_REFRESH_INTERVAL_MS}ms)`);
    }

    async checkDrift() {
        try {
            console.log("Running Drift Check...");

            // Fetch all BTC token balances in parallel using config
            const btcBalancePromises = BTC_ONLY_CONFIG.BTC_TOKENS.map(token =>
                this.nearService.getBalance(token.id).then(bal => ({ 
                    tokenId: token.id, 
                    balance: bal,
                    decimals: token.decimals,
                    symbol: token.symbol
                }))
            );

            // Fetch all USD stablecoin balances in parallel
            const usdBalancePromises = BTC_ONLY_CONFIG.USD_TOKENS.map(token =>
                this.nearService.getBalance(token.id).then(bal => ({
                    tokenId: token.id,
                    balance: bal,
                    decimals: token.decimals,
                    symbol: token.symbol
                }))
            );

            const [perpPos, availableMargin, ...tokenResults] = await Promise.all([
                this.hlService.getBtcPosition(),
                this.hlService.getAvailableMargin(),
                ...btcBalancePromises,
                ...usdBalancePromises
            ]);

            // Split results
            const btcResults = tokenResults.slice(0, BTC_ONLY_CONFIG.BTC_TOKENS.length);
            const usdResults = tokenResults.slice(BTC_ONLY_CONFIG.BTC_TOKENS.length);

            // Calculate total spot BTC across all types
            let totalSpotBtc = 0;
            const btcBreakdown: string[] = [];
            for (const result of btcResults) {
                const balance = result.balance.div(Math.pow(10, result.decimals)).toNumber();
                totalSpotBtc += balance;
                if (balance > 0) {
                    btcBreakdown.push(`${result.symbol}: ${balance.toFixed(8)}`);
                }
            }

            // Calculate total USD across all stablecoins
            let totalSpotUsd = 0;
            const usdBreakdown: string[] = [];
            for (const result of usdResults) {
                const balance = result.balance.div(Math.pow(10, result.decimals)).toNumber();
                totalSpotUsd += balance;
                if (balance > 0) {
                    usdBreakdown.push(`${result.symbol}: $${balance.toFixed(2)}`);
                }
            }

            const netDelta = totalSpotBtc + perpPos;

            console.log(`[Drift Check] Spot BTC: ${totalSpotBtc.toFixed(8)} (${btcBreakdown.join(', ') || 'none'}), Perp: ${perpPos}, Net Delta: ${netDelta}`);
            console.log(`[Drift Check] Spot USD: $${totalSpotUsd.toFixed(2)} (${usdBreakdown.join(', ') || 'none'})`);

            this.logger.logPosition({
                spotBtc: totalSpotBtc,
                spotUsdt: totalSpotUsd,
                perpPosition: perpPos,
                netDelta,
                availableMargin
            });

            if (Math.abs(netDelta) > BTC_ONLY_CONFIG.DRIFT_THRESHOLD_BTC) {
                console.error(`[CRITICAL] HIGH INVENTORY DRIFT DETECTED: ${netDelta} BTC`);
                console.error("Please rebalance manually or enable auto-rebalancer.");
            } else {
                console.log("[Drift Check] Delta is balanced.");
            }

            const canBuy = totalSpotUsd > BTC_ONLY_CONFIG.MIN_USDT_RESERVE;
            const canSell = totalSpotBtc > BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC;
            const canHedge = availableMargin > BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD;

            if (!canHedge) {
                console.warn(`[Status] IDLE - Low Hyperliquid Margin: ${availableMargin} (Required: >${BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD})`);
            } else if (!canBuy && !canSell) {
                console.warn(`[Status] IDLE - Low Inventory`);
                console.warn(`  > Total USD: $${totalSpotUsd.toFixed(2)} (Required: >$${BTC_ONLY_CONFIG.MIN_USDT_RESERVE})`);
                console.warn(`  > Total BTC: ${totalSpotBtc} (Required: >${BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC})`);
            } else {
                const modes = [];
                if (canBuy) modes.push("BUYING");
                if (canSell) modes.push("SELLING");
                console.log(`[Status] READY - Quoting Active (${modes.join(', ')}).`);
            }

            // Log quote rejection stats if quoter is available
            if (this.quoterService) {
                const stats = this.quoterService.getStats();
                if (stats.received > 0) {
                    const rejectionSummary = Object.entries(stats.rejections)
                        .map(([reason, count]) => `${reason}:${count}`)
                        .join(', ') || 'none';
                    console.log(`[QuoteStats] received:${stats.received} generated:${stats.generated} rejections:{${rejectionSummary}}`);
                    this.quoterService.resetStats();
                }
            }

        } catch (e) {
            console.error("[ERROR] Drift Check Failed:", e);
        }
    }

    stop() {
        if (this.driftInterval) {
            clearInterval(this.driftInterval);
            this.driftInterval = null;
        }
        if (this.riskRefreshInterval) {
            clearInterval(this.riskRefreshInterval);
            this.riskRefreshInterval = null;
        }
        console.log("Cron Service Stopped.");
    }
}
