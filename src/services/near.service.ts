import { connect, KeyPair, keyStores, Near, Account } from 'near-api-js';
import { NEAR_CONFIG } from '../configs/near.config';
import BigNumber from 'bignumber.js';
import nacl from 'tweetnacl';

export class NearService {
    private near: Near | undefined;
    private account: Account | undefined;
    private keyPair: any; // Cache the key pair for near-api-js operations
    private secretKey: Uint8Array | undefined; // Raw 64-byte secret key for fast signing
    private publicKeyString: string | undefined; // Pre-encoded public key for hot path
    private balanceCache: Map<string, { balance: BigNumber, timestamp: number, refreshing?: boolean }> = new Map();
    private readonly CACHE_TTL_MS = 10000; // 10 second cache for faster reactions
    private readonly CACHE_REFRESH_THRESHOLD_MS = 7000; // Start background refresh after 7s

    constructor() { }

    async init() {
        if (!NEAR_CONFIG.SOLVER_PRIVATE_KEY) {
            throw new Error("SOLVER_PRIVATE_KEY is required but not set");
        }

        const keyStore = new keyStores.InMemoryKeyStore();
        
        let keyPair: KeyPair;
        try {
            keyPair = KeyPair.fromString(NEAR_CONFIG.SOLVER_PRIVATE_KEY as any);
        } catch (e) {
            throw new Error(`Invalid SOLVER_PRIVATE_KEY format: ${e instanceof Error ? e.message : String(e)}`);
        }

        await keyStore.setKey(NEAR_CONFIG.networkId, NEAR_CONFIG.SOLVER_ID, keyPair);

        this.near = await connect({
            ...NEAR_CONFIG,
            keyStore,
        });

        this.account = await this.near.account(NEAR_CONFIG.SOLVER_ID);

        // Pre-load the key pair for faster signing
        const signerKeyStore = (this.near.connection.signer as any).keyStore;
        this.keyPair = await signerKeyStore.getKey(NEAR_CONFIG.networkId, NEAR_CONFIG.SOLVER_ID);

        if (!this.keyPair) {
            throw new Error("Failed to load keypair after initialization - this should not happen");
        }

        // Extract raw 64-byte secret key for direct tweetnacl signing (faster than KeyPair.sign)
        // The near-api-js KeyPair stores the full 64-byte ed25519 secret key (seed + public key)
        const rawSecretKey = this.keyPair.secretKey || this.keyPair.getSecretKey?.() || null;
        
        if (rawSecretKey && rawSecretKey.length === 64) {
            this.secretKey = new Uint8Array(rawSecretKey);
            console.log(`Using 64-byte secret key from KeyPair (fast path)`);
        } else {
            // Fallback: derive 64-byte key from 32-byte seed using tweetnacl
            const keyString = NEAR_CONFIG.SOLVER_PRIVATE_KEY;
            if (keyString.startsWith('ed25519:')) {
                const bs58Import = await import('bs58');
                const seed = bs58Import.default.decode(keyString.slice(8));
                
                if (seed.length === 32) {
                    // Generate full keypair from 32-byte seed
                    const keypair = nacl.sign.keyPair.fromSeed(seed);
                    this.secretKey = keypair.secretKey; // 64 bytes
                    console.log(`Derived 64-byte secret key from 32-byte seed (fast path)`);
                } else if (seed.length === 64) {
                    // Already have full secret key
                    this.secretKey = seed;
                    console.log(`Using 64-byte secret key from env (fast path)`);
                } else {
                    console.warn(`Unexpected key length: ${seed.length}, falling back to KeyPair.sign`);
                }
            }
        }

        // Pre-encode public key for hot path (avoid bs58.encode per quote)
        const bs58 = await import('bs58');
        this.publicKeyString = `ed25519:${bs58.default.encode(this.keyPair.getPublicKey().data)}`;

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

        // Only fetch intents balance (wallet balance is unused, removing saves ~15-30ms)
        const intentsBalance = await this.account.viewFunction({
            contractId: NEAR_CONFIG.INTENTS_CONTRACT_ID,
            methodName: 'mt_balance_of',
            args: { account_id: this.account.accountId, token_id: `nep141:${tokenId}` }
        }).then(res => new BigNumber(res)).catch((e) => {
            console.warn(`[Balance] Could not fetch intents balance for ${tokenId}:`, e);
            return new BigNumber(0);
        });

        // Cache the result
        this.balanceCache.set(tokenId, { balance: intentsBalance, timestamp: now, refreshing: false });
        return intentsBalance;
    }

    private async refreshBalanceInBackground(tokenId: string): Promise<void> {
        if (!this.account) return;

        try {
            // Only fetch intents balance (wallet balance is unused)
            const intentsBalance = await this.account.viewFunction({
                contractId: NEAR_CONFIG.INTENTS_CONTRACT_ID,
                methodName: 'mt_balance_of',
                args: { account_id: this.account.accountId, token_id: `nep141:${tokenId}` }
            }).then(res => new BigNumber(res)).catch(() => new BigNumber(0));

            this.balanceCache.set(tokenId, { balance: intentsBalance, timestamp: Date.now(), refreshing: false });
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

    // Synchronous sign using tweetnacl directly (faster than near-api-js KeyPair.sign)
    sign(message: Buffer): Uint8Array {
        if (!this.secretKey || this.secretKey.length !== 64) {
            throw new Error("NearService not initialized or secret key not loaded");
        }
        // nacl.sign.detached is ~2-3ms faster than KeyPair.sign wrapper
        return nacl.sign.detached(new Uint8Array(message), this.secretKey);
    }

    // Pre-encoded public key string for hot path
    getPublicKeyString(): string {
        if (!this.publicKeyString) throw new Error("NearService not initialized");
        return this.publicKeyString;
    }

    async wasNonceUsed(nonce: string): Promise<boolean> {
        if (!this.account) return false;
        return this.viewContract(NEAR_CONFIG.INTENTS_CONTRACT_ID, 'is_nonce_used', {
            account_id: this.account.accountId,
            nonce
        });
    }
}
