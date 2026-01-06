import { connect, KeyPair, keyStores, Near, Account } from 'near-api-js';
import { NEAR_CONFIG } from '../configs/near.config';
import BigNumber from 'bignumber.js';

export class NearService {
    private near: Near | undefined;
    private account: Account | undefined;
    private keyPair: any; // Cache the key pair for faster signing
    private balanceCache: Map<string, { balance: BigNumber, timestamp: number, refreshing?: boolean }> = new Map();
    private readonly CACHE_TTL_MS = 30000; // 30 second cache (increased for quote competitiveness)
    private readonly CACHE_REFRESH_THRESHOLD_MS = 20000; // Start background refresh after 20s

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

        // Pre-load the key pair for faster signing
        const signerKeyStore = (this.near.connection.signer as any).keyStore;
        this.keyPair = await signerKeyStore.getKey(NEAR_CONFIG.networkId, NEAR_CONFIG.SOLVER_ID);

        console.log(`NearService initialized for ${NEAR_CONFIG.SOLVER_ID}`);
    }

    getAccount(): Account {
        if (!this.account) throw new Error("NearService not initialized");
        return this.account;
    }

    async getBalance(tokenId: string): Promise<BigNumber> {
        if (!this.account) return new BigNumber(0);

        // Check cache first (stale-while-revalidate pattern)
        const cached = this.balanceCache.get(tokenId);
        const now = Date.now();

        if (cached) {
            const age = now - cached.timestamp;

            // If cache is fresh, return immediately
            if (age < this.CACHE_TTL_MS) {
                // Trigger background refresh if approaching expiry
                if (age > this.CACHE_REFRESH_THRESHOLD_MS && !cached.refreshing) {
                    cached.refreshing = true;
                    this.refreshBalanceInBackground(tokenId).catch(e =>
                        console.warn(`Background refresh failed for ${tokenId}:`, e)
                    );
                }
                return cached.balance;
            }
        }

        // Parallelize wallet and intents balance calls
        const [walletBalance, intentsBalance] = await Promise.all([
            // 1. Wallet Balance (Standard NEP-141)
            this.account.viewFunction({
                contractId: tokenId,
                methodName: 'ft_balance_of',
                args: { account_id: this.account.accountId }
            }).then(res => new BigNumber(res)).catch(() => new BigNumber(0)),

            // 2. Intents Contract Balance (Deposited)
            // The intents contract uses mt_balance_of with "nep141:" prefix
            this.account.viewFunction({
                contractId: NEAR_CONFIG.INTENTS_CONTRACT_ID,
                methodName: 'mt_balance_of',
                args: { account_id: this.account.accountId, token_id: `nep141:${tokenId}` }
            }).then(res => new BigNumber(res)).catch((e) => {
                console.warn(`[Balance] Could not fetch intents balance for ${tokenId}:`, e);
                return new BigNumber(0);
            })
        ]);

        const total = intentsBalance; // Strict Mode: Only funds in Intents Contract are usable for Solver.

        // Cache the result
        this.balanceCache.set(tokenId, { balance: total, timestamp: now, refreshing: false });

        console.log(`[Balance] ${tokenId} | Usable: ${total.toString()} (Intents: ${intentsBalance.toString()}, Wallet [Unusable]: ${walletBalance.toString()})`);
        return total;
    }

    private async refreshBalanceInBackground(tokenId: string): Promise<void> {
        if (!this.account) return;

        try {
            // Parallelize wallet and intents balance calls
            const [walletBalance, intentsBalance] = await Promise.all([
                this.account.viewFunction({
                    contractId: tokenId,
                    methodName: 'ft_balance_of',
                    args: { account_id: this.account.accountId }
                }).then(res => new BigNumber(res)).catch(() => new BigNumber(0)),

                this.account.viewFunction({
                    contractId: NEAR_CONFIG.INTENTS_CONTRACT_ID,
                    methodName: 'mt_balance_of',
                    args: { account_id: this.account.accountId, token_id: `nep141:${tokenId}` }
                }).then(res => new BigNumber(res)).catch(() => new BigNumber(0))
            ]);

            const total = intentsBalance;
            this.balanceCache.set(tokenId, { balance: total, timestamp: Date.now(), refreshing: false });
        } catch (e) {
            // If background refresh fails, mark as not refreshing to allow retry
            const cached = this.balanceCache.get(tokenId);
            if (cached) {
                cached.refreshing = false;
            }
            throw e;
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

    async sign(message: Buffer): Promise<{ signature: Uint8Array; publicKey: { data: Uint8Array } }> {
        if (!this.keyPair) throw new Error("NearService not initialized or key not loaded");

        const signature = this.keyPair.sign(message);
        return {
            signature: signature.signature,
            publicKey: {
                data: this.keyPair.getPublicKey().data
            }
        };
    }

    async wasNonceUsed(nonce: string): Promise<boolean> {
        if (!this.account) return false;
        return this.viewContract(NEAR_CONFIG.INTENTS_CONTRACT_ID, 'is_nonce_used', {
            account_id: this.account.accountId,
            nonce
        });
    }
}
