import { NearService } from './near.service';
import { HyperliquidService } from './hyperliquid.service';
import { BTC_ONLY_CONFIG } from '../configs/btc-only.config';

export interface RiskSnapshot {
    updatedAt: number;
    margin: number;
    btcPos: number;
    fundingRate: number;
    btcBalance: number;
    usdtBalance: number;
}

export class InventoryStateService {
    private emergencyMode = false;
    private cachedDirection: 'BUY_BTC_ONLY' | 'SELL_BTC_ONLY' | 'BOTH' | 'NONE' = 'NONE';
    private riskSnapshot: RiskSnapshot | null = null;
    private readonly SNAPSHOT_MAX_AGE_MS = 30000;
    private refreshing = false;

    constructor(
        private nearService: NearService,
        private hyperliquidService: HyperliquidService
    ) {}

    setEmergencyMode(enabled: boolean) {
        this.emergencyMode = enabled;
        if (enabled) console.warn("!!! EMERGENCY MODE ENABLED - SWITCHING TO SELL ONLY !!!");
    }

    getRiskSnapshot(): RiskSnapshot | null {
        return this.riskSnapshot;
    }

    isSnapshotFresh(): boolean {
        if (!this.riskSnapshot) return false;
        return Date.now() - this.riskSnapshot.updatedAt < this.SNAPSHOT_MAX_AGE_MS;
    }

    async refreshRiskSnapshot(): Promise<void> {
        if (this.refreshing) return;
        this.refreshing = true;

        try {
            const [clearinghouseSnapshot, fundingRate, btcBalanceBN, usdtBalanceBN] = await Promise.all([
                this.hyperliquidService.refreshClearinghouseState(),
                this.hyperliquidService.getFundingRate(),
                this.nearService.getBalance(BTC_ONLY_CONFIG.BTC_TOKEN_ID),
                this.nearService.getBalance(BTC_ONLY_CONFIG.USDT_TOKEN_ID),
            ]);

            this.riskSnapshot = {
                updatedAt: Date.now(),
                margin: clearinghouseSnapshot?.margin ?? 0,
                btcPos: clearinghouseSnapshot?.position ?? 0,
                fundingRate,
                btcBalance: btcBalanceBN.div(1e8).toNumber(),
                usdtBalance: usdtBalanceBN.div(1e6).toNumber(),
            };

            this.cachedDirection = this.computeDirection();
        } catch (e) {
            console.error("Failed to refresh risk snapshot:", e);
        } finally {
            this.refreshing = false;
        }
    }

    private computeDirection(): 'BUY_BTC_ONLY' | 'SELL_BTC_ONLY' | 'BOTH' | 'NONE' {
        if (this.emergencyMode) return 'SELL_BTC_ONLY';

        const snap = this.riskSnapshot;
        if (!snap) return 'NONE';

        if (snap.margin < BTC_ONLY_CONFIG.MIN_MARGIN_THRESHOLD) {
            console.warn(`Low Margin: ${snap.margin}. Halting Quotes.`);
            return 'NONE';
        }

        const canBuyBtc =
            snap.usdtBalance > BTC_ONLY_CONFIG.MIN_USDT_RESERVE &&
            snap.btcBalance < BTC_ONLY_CONFIG.MAX_BTC_INVENTORY;

        const canSellBtc = snap.btcBalance > BTC_ONLY_CONFIG.MIN_TRADE_SIZE_BTC;

        if (canBuyBtc && canSellBtc) return 'BOTH';
        if (canBuyBtc) return 'BUY_BTC_ONLY';
        if (canSellBtc) return 'SELL_BTC_ONLY';
        return 'NONE';
    }

    getQuoteDirection(): 'BUY_BTC_ONLY' | 'SELL_BTC_ONLY' | 'BOTH' | 'NONE' {
        if (this.emergencyMode) return 'SELL_BTC_ONLY';

        if (!this.isSnapshotFresh()) {
            console.warn("Risk snapshot stale or missing – pausing quotes");
            return 'NONE';
        }

        return this.cachedDirection;
    }

    checkPositionCapacity(direction: 'short' | 'long', sizeBtc: number): boolean {
        const snap = this.riskSnapshot;
        if (!snap) {
            console.warn("No risk snapshot available for position capacity check");
            return false;
        }

        const currentPos = snap.btcPos;
        let projectedPos = currentPos;
        projectedPos += direction === 'short' ? -sizeBtc : sizeBtc;

        if (Math.abs(projectedPos) > BTC_ONLY_CONFIG.MAX_BTC_INVENTORY) {
            console.warn(`[RISK] Trade size ${sizeBtc} would exceed max inventory. Projected: ${projectedPos}, Max: ${BTC_ONLY_CONFIG.MAX_BTC_INVENTORY}`);
            return false;
        }
        return true;
    }

    getFundingRate(): number {
        return this.riskSnapshot?.fundingRate ?? 0;
    }
}
