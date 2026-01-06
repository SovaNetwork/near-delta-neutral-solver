
import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { LoggerService } from './logger.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

export class CronService {
    private interval: NodeJS.Timeout | null = null;

    constructor(
        private nearService: NearService,
        private hlService: HyperliquidService,
        private logger: LoggerService
    ) { }

    start() {
        // Run every 10 minutes (checking drift)
        this.interval = setInterval(() => this.checkDrift(), 10 * 60 * 1000);
        console.log("Cron Service Started.");

        // Initial check
        this.checkDrift();
    }

    async checkDrift() {
        try {
            console.log("Running Drift Check...");
            // Spot Balance (Long) vs Perp Position (Short)

            // Parallelize all balance and position checks
            const [spotBtcBN, spotUsdtBN, perpPos, availableMargin] = await Promise.all([
                this.nearService.getBalance(BTC_ONLY_CONFIG.BTC_TOKEN_ID),
                this.nearService.getBalance(BTC_ONLY_CONFIG.USDT_TOKEN_ID),
                this.hlService.getBtcPosition(),
                this.hlService.getAvailableMargin()
            ]);

            const spotBtc = spotBtcBN.div(1e8).toNumber();
            const spotUsdt = spotUsdtBN.div(1e6).toNumber();
            const netDelta = spotBtc + perpPos;

            console.log(`[Drift Check]Spot: ${spotBtc}, Perp: ${perpPos}, Net Delta: ${netDelta} `);

            this.logger.logPosition({
                spotBtc,
                spotUsdt,
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

            // Readiness Check
            const canBuy = spotUsdt > BTC_ONLY_CONFIG.MIN_USDT_RESERVE;
            const canSell = spotBtc > BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC;
            const canHedge = availableMargin > BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD;

            if (!canHedge) {
                console.warn(`[Status] IDLE - Low Hyperliquid Margin: ${availableMargin} (Required: >${BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD})`);
            } else if (!canBuy && !canSell) {
                console.warn(`[Status] IDLE - Low Inventory`);
                console.warn(`  > USDT: ${spotUsdt} (Required: >${BTC_ONLY_CONFIG.MIN_USDT_RESERVE}) [Token: ${BTC_ONLY_CONFIG.USDT_TOKEN_ID}]`);
                console.warn(`  > BTC: ${spotBtc} (Required: >${BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC}) [Token: ${BTC_ONLY_CONFIG.BTC_TOKEN_ID}]`);
            } else {
                const modes = [];
                if (canBuy) modes.push("BUYING");
                if (canSell) modes.push("SELLING");
                console.log(`[Status] READY - Quoting Active (${modes.join(', ')}).`);
            }

        } catch (e) {
            console.error("Drift Check Failed:", e);
        }
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            console.log("Cron Service Stopped.");
        }
    }
}
