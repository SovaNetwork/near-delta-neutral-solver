import * as dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { InfoClient, HttpTransport, MAINNET_API_URL, TESTNET_API_URL } from '@nktkas/hyperliquid';

dotenv.config();

async function checkHLBalance() {
    console.log("=== Hyperliquid Balance Check ===\n");

    const hlPrivateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (!hlPrivateKey) {
        console.error("❌ Missing HYPERLIQUID_PRIVATE_KEY");
        return;
    }

    const wallet = new Wallet(hlPrivateKey);
    const address = wallet.address;
    const isMainnet = process.env.HYPERLIQUID_MAINNET !== 'false';

    console.log(`Network: ${isMainnet ? 'MAINNET' : 'TESTNET'}`);
    console.log(`Address: ${address}\n`);

    try {
        const apiUrl = isMainnet ? MAINNET_API_URL : TESTNET_API_URL;
        console.log(`API URL: ${apiUrl}\n`);

        const transport = new HttpTransport({ url: apiUrl } as any);
        const infoClient = new InfoClient({ transport });

        // Check SPOT balances (where USDC deposits go)
        console.log("Fetching spot clearinghouse state...");
        const spotState = await infoClient.spotClearinghouseState({ user: address });

        console.log("\n=== SPOT BALANCES (RAW RESPONSE) ===");
        console.log(JSON.stringify(spotState, null, 2));

        const balances = spotState.balances || [];
        console.log("\n=== SPOT BALANCES (PARSED) ===");
        if (balances.length === 0) {
            console.log("No spot balances found");
        } else {
            balances.forEach((bal: any) => {
                console.log(`${bal.coin}: ${bal.total} (Hold: ${bal.hold})`);
            });
        }

        const usdcBalance = balances.find((b: any) => b.coin === 'USDC');
        const usdcTotal = usdcBalance ? parseFloat(usdcBalance.total) : 0;
        const usdcHold = usdcBalance ? parseFloat(usdcBalance.hold) : 0;
        const usdcAvailable = usdcTotal - usdcHold;

        console.log(`\nUSDC Total: ${usdcTotal.toFixed(2)}`);
        console.log(`USDC Hold: ${usdcHold.toFixed(2)}`);
        console.log(`USDC Available: ${usdcAvailable.toFixed(2)}`);

        // Check PERPS state (margin for perpetuals trading)
        console.log("\n\nFetching perpetuals clearinghouse state...");
        const perpState = await infoClient.clearinghouseState({ user: address });

        const marginSummary = perpState.marginSummary;
        const positions = perpState.assetPositions;

        console.log("\n=== PERPETUALS MARGIN ===");
        console.log(`Account Value:     ${marginSummary.accountValue}`);
        console.log(`Total Margin Used: ${marginSummary.totalMarginUsed}`);

        const accountValue = parseFloat(marginSummary.accountValue);
        const marginUsed = parseFloat(marginSummary.totalMarginUsed);
        const availableMargin = accountValue - marginUsed;

        console.log(`Available Margin: ${availableMargin.toFixed(2)} USDC`);

        console.log(`\n=== PERPETUALS POSITIONS ===`);
        if (positions.length === 0) {
            console.log("No open positions");
        } else {
            positions.forEach((pos: any) => {
                console.log(`${pos.position.coin}: ${pos.position.szi}`);
            });
        }

        console.log("\n\n=== SUMMARY ===");
        console.log(`USDC in Spot Wallet: ${usdcAvailable.toFixed(2)} USDC`);
        console.log(`USDC in Perps Margin: ${availableMargin.toFixed(2)} USDC`);
        console.log(`Total USDC: ${(usdcAvailable + availableMargin).toFixed(2)} USDC`);

        if (usdcAvailable > 0 && availableMargin === 0) {
            console.log("\n⚠️  NOTICE: You have USDC in spot wallet but not in perpetuals margin.");
            console.log("   To trade perpetuals, you need to transfer USDC from spot to perpetuals.");
            console.log("   Use the Hyperliquid UI or API to transfer funds.");
        }

    } catch (e: any) {
        console.error("\n❌ Error:", e.message || e);
        if (e.response) {
            console.error("Response data:", e.response.data);
        }
    }
}

checkHLBalance().catch(console.error);
