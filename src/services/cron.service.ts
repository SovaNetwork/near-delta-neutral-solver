import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

export class CronService {
    private interval: NodeJS.Timeout | null = null;

    constructor(
        private nearService: NearService,
        private hlService: HyperliquidService
    ) { }

    start() {
        console.log("Starting Drfit Monitor Cron...");
        // Run every hour
        this.interval = setInterval(() => this.checkDrift(), 60 * 60 * 1000);

        // Also run once on startup after short delay
        setTimeout(() => this.checkDrift(), 10000);
    }

    async checkDrift() {
        try {
            console.log("Running Drift Check...");
            // Spot Balance (Long) vs Perp Position (Short)
            // They should be equal in magnitude.
            // Net Delta = Spot - |Perp_Short|

            const spotBtcBN = await this.nearService.getBalance(BTC_ONLY_CONFIG.BTC_TOKEN_ID);
            const spotBtc = spotBtcBN.div(1e8).toNumber();

            const perpPos = await this.hlService.getBtcPosition();
            // perpPos is negative if short.

            // Net Delta = spotBtc + perpPos. (e.g. 1.0 + (-1.0) = 0)
            const netDelta = spotBtc + perpPos;

            console.log(`[Drift Check] Spot: ${spotBtc}, Perp: ${perpPos}, Net Delta: ${netDelta}`);

            if (Math.abs(netDelta) > BTC_ONLY_CONFIG.DRIFT_THRESHOLD_BTC) {
                console.error(`[CRITICAL] HIGH INVENTORY DRIFT DETECTED: ${netDelta} BTC`);
                console.error("Please rebalance manually or enable auto-rebalancer.");
                // Todo: Implement auto-rebalance if enabled (execute hedge to close delta)
            } else {
                console.log("[Drift Check] Delta is balanced.");
            }

        } catch (e) {
            console.error("Drift Check Failed:", e);
        }
    }
}
