import { InfoClient, HttpTransport, MAINNET_API_URL } from '@nktkas/hyperliquid';

async function checkAddress() {
    const depositAddress = '0xC3dD4192D35Da17Bc8C9a43752C4c22136EBB07E';

    console.log(`Checking Hyperliquid balance for: ${depositAddress}\n`);

    const transport = new HttpTransport({ url: MAINNET_API_URL } as any);
    const infoClient = new InfoClient({ transport });

    // Check spot
    const spotState = await infoClient.spotClearinghouseState({ user: depositAddress });
    console.log("SPOT BALANCES:");
    if (spotState.balances.length === 0) {
        console.log("  No spot balances");
    } else {
        spotState.balances.forEach((b: any) => {
            console.log(`  ${b.coin}: ${b.total}`);
        });
    }

    // Check perps
    const perpState = await infoClient.clearinghouseState({ user: depositAddress });
    console.log("\nPERPETUALS MARGIN:");
    console.log(`  Account Value: ${perpState.marginSummary.accountValue} USDC`);
}

checkAddress().catch(console.error);
