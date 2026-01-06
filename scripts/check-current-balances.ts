import * as dotenv from 'dotenv';
import { connect, KeyPair, keyStores } from 'near-api-js';
import { Wallet } from 'ethers';
import { InfoClient, HttpTransport, MAINNET_API_URL, TESTNET_API_URL } from '@nktkas/hyperliquid';

dotenv.config();

async function checkBalances() {
    console.log("=== Current Balance Check ===\n");

    // 1. Check NEAR/Intents Balances
    const solverId = process.env.SOLVER_ID;
    const privateKey = process.env.SOLVER_PRIVATE_KEY;
    const intentsContract = process.env.INTENTS_CONTRACT_ID || 'intents.near';
    const usdtTokenId = process.env.USDT_TOKEN_ID || 'eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
    const btcTokenId = process.env.BTC_TOKEN_ID || 'eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near';

    if (!solverId || !privateKey) {
        console.error("❌ Missing SOLVER_ID or SOLVER_PRIVATE_KEY");
        return;
    }

    const keyStore = new keyStores.InMemoryKeyStore();
    const keyPair = KeyPair.fromString(privateKey);
    await keyStore.setKey('mainnet', solverId, keyPair);

    const near = await connect({
        networkId: 'mainnet',
        nodeUrl: process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org',
        keyStore,
    });

    const account = await near.account(solverId);

    console.log("NEAR BALANCES:");
    console.log(`Solver Account: ${solverId}`);
    console.log(`Intents Contract: ${intentsContract}\n`);

    // Check USDT balances
    let usdtWallet = '0', usdtIntents = '0';
    try {
        usdtWallet = await account.viewFunction({
            contractId: usdtTokenId,
            methodName: 'ft_balance_of',
            args: { account_id: solverId }
        });
    } catch (e) {}

    try {
        usdtIntents = await account.viewFunction({
            contractId: intentsContract,
            methodName: 'mt_balance_of',
            args: { account_id: solverId, token_id: `nep141:${usdtTokenId}` }
        });
    } catch (e) {
        console.error("Error fetching USDT intents:", e);
    }

    const usdtWalletFloat = parseFloat(usdtWallet) / 1e6;
    const usdtIntentsFloat = parseFloat(usdtIntents) / 1e6;
    const usdtTotal = usdtWalletFloat + usdtIntentsFloat;

    console.log(`USDT Wallet:  ${usdtWalletFloat.toFixed(2)} USDT`);
    console.log(`USDT Intents: ${usdtIntentsFloat.toFixed(2)} USDT`);
    console.log(`USDT Total:   ${usdtTotal.toFixed(2)} USDT`);
    console.log(`USDT Usable (Intents only): ${usdtIntentsFloat.toFixed(2)} USDT\n`);

    // Check BTC balances
    let btcWallet = '0', btcIntents = '0';
    try {
        btcWallet = await account.viewFunction({
            contractId: btcTokenId,
            methodName: 'ft_balance_of',
            args: { account_id: solverId }
        });
    } catch (e) {}

    try {
        btcIntents = await account.viewFunction({
            contractId: intentsContract,
            methodName: 'mt_balance_of',
            args: { account_id: solverId, token_id: `nep141:${btcTokenId}` }
        });
    } catch (e) {
        console.error("Error fetching BTC intents:", e);
    }

    const btcWalletFloat = parseFloat(btcWallet) / 1e8;
    const btcIntentsFloat = parseFloat(btcIntents) / 1e8;
    const btcTotal = btcWalletFloat + btcIntentsFloat;

    console.log(`BTC Wallet:  ${btcWalletFloat.toFixed(8)} BTC`);
    console.log(`BTC Intents: ${btcIntentsFloat.toFixed(8)} BTC`);
    console.log(`BTC Total:   ${btcTotal.toFixed(8)} BTC`);
    console.log(`BTC Usable (Intents only): ${btcIntentsFloat.toFixed(8)} BTC\n`);

    // 2. Check Hyperliquid Balance
    const hlPrivateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (!hlPrivateKey) {
        console.error("❌ Missing HYPERLIQUID_PRIVATE_KEY");
        return;
    }

    const wallet = new Wallet(hlPrivateKey);
    const hlAddress = wallet.address;

    console.log("HYPERLIQUID BALANCE:");
    console.log(`Address: ${hlAddress}\n`);

    try {
        const isMainnet = process.env.HYPERLIQUID_MAINNET !== 'false';
        const apiUrl = isMainnet ? MAINNET_API_URL : TESTNET_API_URL;
        const transport = new HttpTransport({ url: apiUrl } as any);
        const infoClient = new InfoClient({ transport });

        const userState = await infoClient.clearinghouseState({ user: hlAddress });
        const marginSummary = userState.marginSummary;
        const positions = userState.assetPositions;

        const accountValue = parseFloat(marginSummary.accountValue);
        const marginUsed = parseFloat(marginSummary.totalMarginUsed);
        const availableMargin = accountValue - marginUsed;

        console.log(`Account Value:     ${accountValue.toFixed(2)} USDC`);
        console.log(`Margin Used:       ${marginUsed.toFixed(2)} USDC`);
        console.log(`Available Margin:  ${availableMargin.toFixed(2)} USDC\n`);

        // Check BTC position
        const btcPos = positions.find((p: any) => p.position.coin === 'BTC');
        if (btcPos) {
            const size = parseFloat(btcPos.position.szi);
            console.log(`BTC Perp Position: ${size.toFixed(8)} BTC`);
        } else {
            console.log(`BTC Perp Position: 0 BTC`);
        }

    } catch (e: any) {
        console.error("❌ Error checking Hyperliquid:", e.message || e);
    }

    console.log("\n--- READINESS CHECK ---");
    const minUsdt = parseFloat(process.env.MIN_USDT_RESERVE || '50');
    const minBtc = parseFloat(process.env.MIN_TRADE_SIZE_BTC || '0.0001');
    const minMargin = parseFloat(process.env.MIN_MARGIN_THRESHOLD || '300');

    console.log(`\nRequired Minimums:`);
    console.log(`  USDT in Intents: ${minUsdt} USDT (Current: ${usdtIntentsFloat.toFixed(2)})`);
    console.log(`  BTC in Intents:  ${minBtc} BTC (Current: ${btcIntentsFloat.toFixed(8)})`);
    console.log(`  HL Margin:       ${minMargin} USDC\n`);

    if (usdtIntentsFloat >= minUsdt) {
        console.log("✅ USDT balance sufficient for buying BTC");
    } else {
        console.log(`❌ Need to deposit ${(minUsdt - usdtIntentsFloat).toFixed(2)} more USDT into Intents`);
    }

    if (btcIntentsFloat >= minBtc) {
        console.log("✅ BTC balance sufficient for selling BTC");
    } else {
        console.log(`❌ Need to deposit ${(minBtc - btcIntentsFloat).toFixed(8)} more BTC into Intents`);
    }
}

checkBalances().catch(console.error);
