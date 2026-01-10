import * as dotenv from 'dotenv';
dotenv.config();

import { InfoClient, ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { Wallet } from 'ethers';

const isMainnet = process.env.HYPERLIQUID_MAINNET !== 'false';

async function main() {
    const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (!privateKey) {
        console.error('HYPERLIQUID_PRIVATE_KEY not set');
        process.exit(1);
    }

    const wallet = new Wallet(privateKey);
    console.log(`Wallet address: ${wallet.address}`);
    console.log(`Network: ${isMainnet ? 'Mainnet' : 'Testnet'}\n`);

    const httpTransport = new HttpTransport({ isTestnet: !isMainnet });
    const infoClient = new InfoClient({ transport: httpTransport });
    const exchangeClient = new ExchangeClient({ transport: httpTransport, wallet });

    // Get current state
    const userState = await infoClient.clearinghouseState({ user: wallet.address });
    const marginSummary = userState.marginSummary;
    const positions = userState.assetPositions;
    
    const btcPos = positions.find((p: any) => p.position.coin === 'BTC');
    const currentPosition = btcPos ? parseFloat(btcPos.position.szi) : 0;
    const entryPx = btcPos ? parseFloat(btcPos.position.entryPx) : 0;
    const unrealizedPnl = btcPos ? parseFloat(btcPos.position.unrealizedPnl) : 0;

    console.log('=== Current Hyperliquid State ===');
    console.log(`Account Value: $${parseFloat(marginSummary.accountValue).toFixed(2)}`);
    console.log(`Available Margin: $${(parseFloat(marginSummary.accountValue) - parseFloat(marginSummary.totalMarginUsed)).toFixed(2)}`);
    console.log(`BTC Position: ${currentPosition} BTC`);
    console.log(`Entry Price: $${entryPx.toFixed(2)}`);
    console.log(`Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n`);

    // Parse command line args
    const args = process.argv.slice(2);
    const command = args[0];
    const size = args[1] ? parseFloat(args[1]) : null;

    if (!command) {
        console.log('Usage:');
        console.log('  npx ts-node scripts/rebalance.ts status           - Show current position');
        console.log('  npx ts-node scripts/rebalance.ts buy <size>       - Buy BTC (reduce short / go long)');
        console.log('  npx ts-node scripts/rebalance.ts sell <size>      - Sell BTC (increase short / reduce long)');
        console.log('  npx ts-node scripts/rebalance.ts close            - Close entire position');
        console.log('');
        console.log('Examples:');
        console.log('  npx ts-node scripts/rebalance.ts buy 0.00555      - Buy 0.00555 BTC to reduce short');
        console.log('  npx ts-node scripts/rebalance.ts close            - Close entire -0.01592 BTC position');
        return;
    }

    if (command === 'status') {
        // Already printed above
        return;
    }

    // Get current price
    const meta = await infoClient.meta();
    const btcIndex = meta.universe.findIndex((a: any) => a.name === 'BTC');
    
    const metaAndCtxs = await infoClient.metaAndAssetCtxs();
    const btcCtx = metaAndCtxs[1][btcIndex];
    const markPrice = parseFloat(btcCtx.markPx);
    console.log(`Current BTC Mark Price: $${markPrice.toFixed(2)}\n`);

    let orderSize: number;
    let isBuy: boolean;

    if (command === 'close') {
        if (currentPosition === 0) {
            console.log('No position to close.');
            return;
        }
        // To close a short (-0.01592), we need to BUY
        // To close a long (+X), we need to SELL
        isBuy = currentPosition < 0;
        orderSize = Math.abs(currentPosition);
        console.log(`Closing entire position: ${isBuy ? 'BUY' : 'SELL'} ${orderSize} BTC`);
    } else if (command === 'buy' || command === 'sell') {
        if (!size || size <= 0) {
            console.error('Invalid size. Usage: rebalance.ts buy <size>');
            process.exit(1);
        }
        isBuy = command === 'buy';
        orderSize = size;
    } else {
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }

    // Round to 5 decimals (HL BTC precision)
    orderSize = Math.floor(orderSize * 100000) / 100000;
    
    if (orderSize < 0.0001) {
        console.error('Size too small (minimum 0.0001 BTC)');
        process.exit(1);
    }

    // Calculate limit price with 0.1% slippage
    const slippageBps = 10; // 0.1%
    const limitPrice = isBuy 
        ? Math.ceil(markPrice * (1 + slippageBps / 10000))
        : Math.floor(markPrice * (1 - slippageBps / 10000));

    console.log(`Executing: ${isBuy ? 'BUY' : 'SELL'} ${orderSize} BTC @ $${limitPrice} (IOC)`);
    console.log('');

    // Confirm
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    
    const answer = await new Promise<string>((resolve) => {
        rl.question('Confirm trade? (yes/no): ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        console.log('Cancelled.');
        return;
    }

    console.log('\nSubmitting order...');

    try {
        const result = await exchangeClient.order({
            orders: [{
                a: btcIndex,
                b: isBuy,
                p: limitPrice.toString(),
                s: orderSize.toString(),
                r: false,
                t: { limit: { tif: 'Ioc' } }
            }],
            grouping: 'na'
        });

        console.log('\n=== Order Result ===');
        
        if (result.response?.data?.statuses) {
            const status = result.response.data.statuses[0] as any;
            if (status?.filled) {
                console.log(`✅ FILLED: ${status.filled.totalSz} BTC @ $${status.filled.avgPx}`);
                
                // Show new position
                const newState = await infoClient.clearinghouseState({ user: wallet.address });
                const newBtcPos = newState.assetPositions.find((p: any) => p.position.coin === 'BTC');
                const newPosition = newBtcPos ? parseFloat(newBtcPos.position.szi) : 0;
                console.log(`\nNew BTC Position: ${newPosition} BTC`);
            } else if (status?.error) {
                console.log(`❌ ERROR: ${status.error}`);
            } else if (status?.resting) {
                console.log(`⚠️  Order resting (unexpected for IOC): ${JSON.stringify(status.resting)}`);
            } else {
                console.log(`⚠️  Unknown status: ${JSON.stringify(status)}`);
            }
        } else {
            console.log('Response:', JSON.stringify(result, null, 2));
        }
    } catch (e) {
        console.error('Order failed:', e);
        process.exit(1);
    }
}

main().catch(console.error);
