import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { NEAR_CONFIG } from '../configs/near.config';

interface QuoteData {
    direction: 'short' | 'long'; // If we bought BTC, we execute 'short'.
    amountBtc: number;
    quoteId: string;
}

export class HedgerService {
    private pendingQuotes = new Map<string, QuoteData>(); // nonce -> data
    private pollInterval: NodeJS.Timeout | null = null;
    private processing = false; // Simple lock to avoid overlapping polls if slow

    constructor(
        private nearService: NearService,
        private hlService: HyperliquidService
    ) { }

    start() {
        if (this.pollInterval) return;
        console.log("Hedger Service Started. Polling for settlements...");
        this.pollInterval = setInterval(() => this.poll(), 2000);
    }

    trackQuote(nonce: string, data: QuoteData) {
        // console.log(`Tracking quote nonce: ${nonce}`);
        this.pendingQuotes.set(nonce, data);
    }

    private async poll() {
        if (this.processing) return;
        this.processing = true;

        try {
            const nonces = Array.from(this.pendingQuotes.keys());
            if (nonces.length === 0) {
                this.processing = false;
                return;
            }

            // Optimization: Maybe check multiple nonces at once if contract supports it.
            // For now, check one by one.
            for (const nonce of nonces) {
                try {
                    const isUsed = await this.nearService.viewContract(
                        NEAR_CONFIG.INTENTS_CONTRACT_ID,
                        'is_nonce_used',
                        { nonce }
                    );

                    if (isUsed) {
                        console.log(`Settlement Detected for nonce ${nonce}! Executing Hedge...`);
                        const data = this.pendingQuotes.get(nonce);
                        if (data) {
                            await this.hlService.executeHedge(data.direction, data.amountBtc);
                            this.pendingQuotes.delete(nonce);
                            console.log(`Hedge Completed for ${nonce}`);
                        }
                    } else {
                        // Check expiry? If too old, remove?
                        // For now, keep tracking.
                    }
                } catch (e) {
                    console.error(`Error checking nonce ${nonce}:`, e);
                }
            }

        } catch (e) {
            console.error("Hedger Loop Error:", e);
        } finally {
            this.processing = false;
        }
    }
}
