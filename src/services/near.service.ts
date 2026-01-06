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
        try {
            const balanceStr = await this.account.viewFunction({
                contractId: tokenId,
                methodName: 'ft_balance_of',
                args: { account_id: this.account.accountId }
            });
            console.log(`[NearService] Balance for ${tokenId}: ${balanceStr}`);
            return new BigNumber(balanceStr);
        } catch (e) {
            console.error(`Failed to get balance for ${tokenId}:`, e);
            return new BigNumber(0);
        }
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
