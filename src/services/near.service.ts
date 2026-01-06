import { connect, KeyPair, keyStores, Near, Account } from 'near-api-js';
import { NEAR_CONFIG } from '../configs/near.config';
import BigNumber from 'bignumber.js';

export class NearService {
    private near: Near | undefined;
    private account: Account | undefined;

    constructor() { }

    async init() {
        const keyStore = new keyStores.InMemoryKeyStore();
        if (NEAR_CONFIG.SOLVER_PRIVATE_KEY) {
            try {
                const keyPair = KeyPair.fromString(NEAR_CONFIG.SOLVER_PRIVATE_KEY as any);
                await keyStore.setKey(NEAR_CONFIG.networkId, NEAR_CONFIG.SOLVER_ID, keyPair);
            } catch (e) {
                console.warn("Invalid SOLVER_PRIVATE_KEY, proceeding without signing capability.");
            }
        }

        this.near = await connect({
            ...NEAR_CONFIG,
            keyStore,
        });

        this.account = await this.near.account(NEAR_CONFIG.SOLVER_ID);
        console.log(`NearService initialized for ${NEAR_CONFIG.SOLVER_ID}`);
    }

    getAccount(): Account {
        if (!this.account) throw new Error("NearService not initialized");
        return this.account;
    }

    async getBalance(tokenId: string): Promise<BigNumber> {
        if (!this.account) return new BigNumber(0);

        // 1. Wallet Balance (Standard NEP-141)
        let walletBalance = new BigNumber(0);
        try {
            const res = await this.account.viewFunction({
                contractId: tokenId,
                methodName: 'ft_balance_of',
                args: { account_id: this.account.accountId }
            });
            walletBalance = new BigNumber(res);
        } catch (e) {
            // Ignore errors for wallet balance (e.g. token not registered)
        }

        // 2. Intents Contract Balance (Deposited)
        // The intents contract uses mt_balance_of with "nep141:" prefix
        let intentsBalance = new BigNumber(0);
        try {
            const res = await this.account.viewFunction({
                contractId: NEAR_CONFIG.INTENTS_CONTRACT_ID,
                methodName: 'mt_balance_of',
                args: { account_id: this.account.accountId, token_id: `nep141:${tokenId}` }
            });
            intentsBalance = new BigNumber(res);
        } catch (e) {
            // Ignore errors or log warning if critical
            console.warn(`[Balance] Could not fetch intents balance for ${tokenId}:`, e);
        }

        const total = intentsBalance; // Strict Mode: Only funds in Intents Contract are usable for Solver.
        console.log(`[Balance] ${tokenId} | Usable: ${total.toString()} (Intents: ${intentsBalance.toString()}, Wallet [Unusable]: ${walletBalance.toString()})`);
        return total;
    }

    async viewContract(contractId: string, method: string, args: any): Promise<any> {
        if (!this.account) throw new Error("NearService not initialized");
        return this.account.viewFunction({
            contractId,
            methodName: method,
            args
        });
    }

    async sign(message: string): Promise<string> {
        if (!this.near) throw new Error("NearService not initialized");
        const keyStore = (this.near.connection.signer as any).keyStore;
        const keyPair = await keyStore.getKey(NEAR_CONFIG.networkId, NEAR_CONFIG.SOLVER_ID);
        if (!keyPair) throw new Error("No private key found for signing");

        const msgBuffer = Buffer.from(message);
        const signature = keyPair.sign(msgBuffer);
        return Buffer.from(signature.signature).toString('hex');
    }

    async wasNonceUsed(nonce: string): Promise<boolean> {
        return this.viewContract(NEAR_CONFIG.INTENTS_CONTRACT_ID, 'is_nonce_used', { nonce });
    }
}
