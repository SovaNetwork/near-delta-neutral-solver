import * as dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { connect, KeyPair, keyStores } from 'near-api-js';
import { InfoClient, HttpTransport, MAINNET_API_URL } from '@nktkas/hyperliquid';

dotenv.config();

async function checkBalances() {
    console.log("=== Balance Diagnostic Tool ===\n");

    // 1. Check Hyperliquid Wallet
    console.log("1. HYPERLIQUID WALLET CHECK:");
    const hlPrivateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
    const hlConfiguredAddress = process.env.HYPERLIQUID_WALLET_ADDRESS;

    if (!hlPrivateKey) {
        console.error("❌ HYPERLIQUID_PRIVATE_KEY not set in .env");
    } else {
        const wallet = new Wallet(hlPrivateKey);
        const derivedAddress = wallet.address;

        console.log(`   Derived Address from Private Key: ${derivedAddress}`);
        console.log(`   Configured Address in .env:       ${hlConfiguredAddress || 'NOT SET'}`);

        if (hlConfiguredAddress && hlConfiguredAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
            console.log("   ⚠️  WARNING: Address mismatch! Using derived address.");
        }

        // Check balance on Hyperliquid
        try {
            const isMainnet = process.env.HYPERLIQUID_MAINNET !== 'false';
            const apiUrl = isMainnet ? MAINNET_API_URL : 'https://api.hyperliquid-testnet.xyz';
            const transport = new HttpTransport({ url: apiUrl } as any);
            const infoClient = new InfoClient({ transport });

            const userState = await infoClient.clearinghouseState({ user: derivedAddress });
            const marginSummary = userState.marginSummary;

            console.log(`\n   Account Value (USDC): ${marginSummary.accountValue}`);
            console.log(`   Total Margin Used:    ${marginSummary.totalMarginUsed}`);
            console.log(`   Available Margin:     ${parseFloat(marginSummary.accountValue) - parseFloat(marginSummary.totalMarginUsed)}`);

            if (parseFloat(marginSummary.accountValue) === 0) {
                console.log("   ❌ ISSUE: Hyperliquid wallet has ZERO balance!");
                console.log("   → Fund this address with USDC on Arbitrum network");
            } else {
                console.log("   ✅ Hyperliquid wallet has funds");
            }
        } catch (e) {
            console.error("   ❌ Error checking Hyperliquid balance:", e);
        }
    }

    // 2. Check NEAR Wallet
    console.log("\n2. NEAR WALLET CHECK:");
    const solverPrivateKey = process.env.SOLVER_PRIVATE_KEY;
    const solverId = process.env.SOLVER_ID;

    if (!solverPrivateKey || !solverId) {
        console.error("❌ SOLVER_PRIVATE_KEY or SOLVER_ID not set");
        return;
    }

    console.log(`   Solver Account: ${solverId}`);

    try {
        const keyStore = new keyStores.InMemoryKeyStore();
        const keyPair = KeyPair.fromString(solverPrivateKey);
        await keyStore.setKey('mainnet', solverId, keyPair);

        const near = await connect({
            networkId: 'mainnet',
            nodeUrl: process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org',
            keyStore,
        });

        const account = await near.account(solverId);

        // Check NEAR balance
        const balance = await account.getAccountBalance();
        console.log(`   NEAR Balance: ${(parseFloat(balance.available) / 1e24).toFixed(4)} NEAR`);

        // Check token balances
        const intentsContract = process.env.INTENTS_CONTRACT_ID || 'intents.near';
        const btcTokenId = process.env.BTC_TOKEN_ID || 'eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near';
        const usdtTokenId = process.env.USDT_TOKEN_ID || 'eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';

        console.log(`\n   Checking token balances for intents contract: ${intentsContract}`);

        // BTC Balance in Wallet
        let btcWalletBalance = '0';
        try {
            btcWalletBalance = await account.viewFunction({
                contractId: btcTokenId,
                methodName: 'ft_balance_of',
                args: { account_id: solverId }
            });
            console.log(`   BTC Wallet Balance: ${btcWalletBalance} (${(parseFloat(btcWalletBalance) / 1e8).toFixed(8)} BTC)`);
        } catch (e) {
            console.log(`   BTC Wallet Balance: Not registered or 0`);
        }

        // BTC Balance in Intents
        let btcIntentsBalance = '0';
        try {
            btcIntentsBalance = await account.viewFunction({
                contractId: intentsContract,
                methodName: 'get_balance',
                args: { account_id: solverId, token_id: btcTokenId }
            });
            console.log(`   BTC Intents Balance: ${btcIntentsBalance} (${(parseFloat(btcIntentsBalance) / 1e8).toFixed(8)} BTC)`);
        } catch (e) {
            console.log(`   BTC Intents Balance: Not registered or 0`);
        }

        // USDT Balance in Wallet
        let usdtWalletBalance = '0';
        try {
            usdtWalletBalance = await account.viewFunction({
                contractId: usdtTokenId,
                methodName: 'ft_balance_of',
                args: { account_id: solverId }
            });
            console.log(`   USDT Wallet Balance: ${usdtWalletBalance} (${(parseFloat(usdtWalletBalance) / 1e6).toFixed(2)} USDT)`);
        } catch (e) {
            console.log(`   USDT Wallet Balance: Not registered or 0`);
        }

        // USDT Balance in Intents
        let usdtIntentsBalance = '0';
        try {
            usdtIntentsBalance = await account.viewFunction({
                contractId: intentsContract,
                methodName: 'get_balance',
                args: { account_id: solverId, token_id: usdtTokenId }
            });
            console.log(`   USDT Intents Balance: ${usdtIntentsBalance} (${(parseFloat(usdtIntentsBalance) / 1e6).toFixed(2)} USDT)`);
        } catch (e) {
            console.log(`   USDT Intents Balance: Not registered or 0`);
        }

        // Summary
        console.log("\n3. SUMMARY:");
        const totalBtc = (parseFloat(btcWalletBalance) + parseFloat(btcIntentsBalance)) / 1e8;
        const totalUsdt = (parseFloat(usdtWalletBalance) + parseFloat(usdtIntentsBalance)) / 1e6;

        console.log(`   Total BTC Available: ${totalBtc.toFixed(8)} BTC`);
        console.log(`   Total USDT Available: ${totalUsdt.toFixed(2)} USDT`);

        if (parseFloat(btcIntentsBalance) === 0 && parseFloat(usdtIntentsBalance) === 0) {
            console.log("\n   ❌ ISSUE: No funds deposited in Intents contract!");
            console.log("   → You need to deposit BTC and USDT into the Intents contract");
            console.log(`   → Contract: ${intentsContract}`);
            console.log(`   → Solver Account: ${solverId}`);
        } else {
            console.log("\n   ✅ Funds found in Intents contract");
        }

    } catch (e) {
        console.error("   ❌ Error checking NEAR balances:", e);
    }
}

checkBalances().catch(console.error);
