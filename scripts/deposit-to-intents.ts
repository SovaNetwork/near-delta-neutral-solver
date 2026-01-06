import * as dotenv from 'dotenv';
import { connect, KeyPair, keyStores, transactions, utils } from 'near-api-js';
import * as readline from 'readline';

dotenv.config();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
}

async function depositToIntents() {
    console.log("=== Deposit Tokens to Intents Contract ===\n");

    const solverId = process.env.SOLVER_ID;
    const privateKey = process.env.SOLVER_PRIVATE_KEY;
    const intentsContract = process.env.INTENTS_CONTRACT_ID || 'intents.near';
    const usdtTokenId = process.env.USDT_TOKEN_ID || 'eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
    const btcTokenId = process.env.BTC_TOKEN_ID || 'eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near';

    if (!solverId || !privateKey) {
        console.error("❌ SOLVER_ID or SOLVER_PRIVATE_KEY not set");
        rl.close();
        return;
    }

    // Connect to NEAR
    const keyStore = new keyStores.InMemoryKeyStore();
    const keyPair = KeyPair.fromString(privateKey);
    await keyStore.setKey('mainnet', solverId, keyPair);

    const near = await connect({
        networkId: 'mainnet',
        nodeUrl: process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org',
        keyStore,
    });

    const account = await near.account(solverId);

    console.log(`Solver Account: ${solverId}`);
    console.log(`Intents Contract: ${intentsContract}\n`);

    // Check current balances
    console.log("Checking current balances...\n");

    // USDT Wallet Balance
    let usdtWalletBalance = '0';
    try {
        usdtWalletBalance = await account.viewFunction({
            contractId: usdtTokenId,
            methodName: 'ft_balance_of',
            args: { account_id: solverId }
        });
        console.log(`USDT Wallet Balance: ${usdtWalletBalance} (${(parseFloat(usdtWalletBalance) / 1e6).toFixed(2)} USDT)`);
    } catch (e) {
        console.log(`USDT Wallet Balance: Not registered or 0`);
    }

    // USDT Intents Balance
    let usdtIntentsBalance = '0';
    try {
        usdtIntentsBalance = await account.viewFunction({
            contractId: intentsContract,
            methodName: 'get_balance',
            args: { account_id: solverId, token_id: usdtTokenId }
        });
        console.log(`USDT Intents Balance: ${usdtIntentsBalance} (${(parseFloat(usdtIntentsBalance) / 1e6).toFixed(2)} USDT)`);
    } catch (e) {
        console.log(`USDT Intents Balance: Not registered or 0`);
    }

    // BTC Wallet Balance
    let btcWalletBalance = '0';
    try {
        btcWalletBalance = await account.viewFunction({
            contractId: btcTokenId,
            methodName: 'ft_balance_of',
            args: { account_id: solverId }
        });
        console.log(`BTC Wallet Balance: ${btcWalletBalance} (${(parseFloat(btcWalletBalance) / 1e8).toFixed(8)} BTC)`);
    } catch (e) {
        console.log(`BTC Wallet Balance: Not registered or 0`);
    }

    // BTC Intents Balance
    let btcIntentsBalance = '0';
    try {
        btcIntentsBalance = await account.viewFunction({
            contractId: intentsContract,
            methodName: 'get_balance',
            args: { account_id: solverId, token_id: btcTokenId }
        });
        console.log(`BTC Intents Balance: ${btcIntentsBalance} (${(parseFloat(btcIntentsBalance) / 1e8).toFixed(8)} BTC)`);
    } catch (e) {
        console.log(`BTC Intents Balance: Not registered or 0`);
    }

    console.log("\n--- Deposit Options ---");
    console.log("1. Deposit USDT");
    console.log("2. Deposit BTC");
    console.log("3. Exit");

    const choice = await question("\nSelect option (1-3): ");

    if (choice === '3') {
        console.log("Exiting...");
        rl.close();
        return;
    }

    let tokenId: string;
    let decimals: number;
    let tokenName: string;
    let walletBalance: string;

    if (choice === '1') {
        tokenId = usdtTokenId;
        decimals = 6;
        tokenName = 'USDT';
        walletBalance = usdtWalletBalance;
    } else if (choice === '2') {
        tokenId = btcTokenId;
        decimals = 8;
        tokenName = 'BTC';
        walletBalance = btcWalletBalance;
    } else {
        console.log("Invalid choice");
        rl.close();
        return;
    }

    const walletBalanceFloat = parseFloat(walletBalance) / Math.pow(10, decimals);
    console.log(`\nAvailable ${tokenName} in wallet: ${walletBalanceFloat.toFixed(decimals)} ${tokenName}`);

    const amountStr = await question(`\nEnter amount to deposit (in ${tokenName}): `);
    const amount = parseFloat(amountStr);

    if (isNaN(amount) || amount <= 0) {
        console.log("Invalid amount");
        rl.close();
        return;
    }

    if (amount > walletBalanceFloat) {
        console.log(`❌ Insufficient balance. You only have ${walletBalanceFloat.toFixed(decimals)} ${tokenName}`);
        rl.close();
        return;
    }

    const amountRaw = Math.floor(amount * Math.pow(10, decimals)).toString();

    console.log(`\nPreparing to deposit ${amount} ${tokenName} (${amountRaw} raw units) to ${intentsContract}...`);

    const confirm = await question("Confirm? (yes/no): ");
    if (confirm.toLowerCase() !== 'yes') {
        console.log("Cancelled");
        rl.close();
        return;
    }

    try {
        console.log("\nSending transaction...");

        // ft_transfer_call to deposit into intents contract
        const result = await account.functionCall({
            contractId: tokenId,
            methodName: 'ft_transfer_call',
            args: {
                receiver_id: intentsContract,
                amount: amountRaw,
                msg: ''
            },
            gas: '300000000000000', // 300 TGas
            attachedDeposit: '1' // 1 yoctoNEAR for security
        });

        console.log("\n✅ Deposit successful!");
        console.log(`Transaction: https://explorer.near.org/transactions/${result.transaction.hash}`);

        // Check new balance
        console.log("\nChecking new balance...");
        const newIntentsBalance = await account.viewFunction({
            contractId: intentsContract,
            methodName: 'get_balance',
            args: { account_id: solverId, token_id: tokenId }
        });

        const newBalanceFloat = parseFloat(newIntentsBalance) / Math.pow(10, decimals);
        console.log(`New ${tokenName} Intents Balance: ${newBalanceFloat.toFixed(decimals)} ${tokenName}`);

    } catch (e: any) {
        console.error("\n❌ Deposit failed:", e.message || e);
        if (e.type === 'FunctionCallError') {
            console.error("Function call error details:", e);
        }
    }

    rl.close();
}

depositToIntents().catch(console.error);
