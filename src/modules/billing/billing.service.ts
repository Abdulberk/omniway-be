import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { WalletService } from './wallet.service';
import { ModelPricingService } from './model-pricing.service';
import { AuthContext } from '../auth/interfaces/auth.interfaces';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    BillingResult,
    DailyUsageInfo,
    BILLING_KEYS,
    BILLING_CONSTANTS,
    toBillingOwnerType,
    getUtcDateString,
    secondsUntilUtcMidnight,
} from './interfaces/billing.interfaces';

/**
 * Billing Service
 * Handles atomic billing decisions using Lua script
 */
@Injectable()
export class BillingService {
    private readonly logger = new Logger(BillingService.name);
    private billingScript: string;

    constructor(
        private readonly redis: RedisService,
        private readonly walletService: WalletService,
        private readonly pricingService: ModelPricingService,
    ) {
        this.billingScript = this.loadScript('billing.lua');
    }

    private loadScript(filename: string): string {
        try {
            return readFileSync(join(__dirname, 'lua', filename), 'utf-8');
        } catch (error) {
            this.logger.error(`Failed to load Lua script: ${filename}`, error);
            throw error;
        }
    }

    /**
     * Execute billing check and charge
     * Uses atomic Lua script for allowance-or-wallet decision
     */
    async chargeBilling(
        authContext: AuthContext,
        requestId: string,
        model: string,
    ): Promise<BillingResult> {
        const ownerType = toBillingOwnerType(authContext.ownerType);
        const ownerId = authContext.ownerId;
        const dateStr = getUtcDateString();

        // Get model pricing
        const pricing = await this.pricingService.getModelPricing(model);

        // Check if wallet access is available
        const canUseWallet = authContext.policy.hasWalletAccess;
        const priceCents = canUseWallet ? pricing.priceCents : 0;

        // Prepare Redis keys
        const allowanceKey = BILLING_KEYS.allowanceUsed(ownerType, ownerId, dateStr);
        const walletKey = BILLING_KEYS.walletBalance(ownerType, ownerId);
        const idemKey = BILLING_KEYS.billingIdempotency(ownerType, ownerId, requestId);
        const lockedKey = BILLING_KEYS.walletLocked(ownerType, ownerId);

        // Calculate TTLs
        const dayTtl = secondsUntilUtcMidnight();
        const idemTtl = BILLING_CONSTANTS.IDEMPOTENCY_TTL_SECONDS;

        try {
            const result = await this.redis.evalLua<(number | string)[]>(
                this.billingScript,
                [allowanceKey, walletKey, idemKey, lockedKey],
                [
                    authContext.policy.dailyAllowance,
                    priceCents,
                    requestId,
                    idemTtl,
                    dayTtl,
                ],
            );

            const [code, source, chargedCents, allowanceRemaining, walletBalanceCents] = result;

            const billingResult: BillingResult = {
                code: Number(code) as 0 | 1 | 2,
                source: String(source) as BillingResult['source'],
                chargedCents: Number(chargedCents),
                allowanceRemaining: Number(allowanceRemaining),
                walletBalanceCents: String(walletBalanceCents),
            };

            // If wallet was charged, record to database SYNCHRONOUSLY
            if (billingResult.code === 1 && billingResult.source === 'wallet' && billingResult.chargedCents > 0) {
                try {
                    await this.walletService.recordCharge({
                        ownerType,
                        ownerId,
                        amountCents: billingResult.chargedCents,
                        requestId,
                        model,
                        newBalanceFromLua: BigInt(billingResult.walletBalanceCents),
                    });
                } catch (dbError) {
                    // Database write failed - rollback Redis
                    this.logger.error(
                        `DB write failed after billing, rolling back Redis for ${ownerType}:${ownerId}`,
                        dbError,
                    );
                    await this.walletService.rollbackRedis(ownerType, ownerId, billingResult.chargedCents);
                    throw dbError;
                }
            }

            return billingResult;
        } catch (error) {
            this.logger.error(
                `Billing check failed for ${ownerType}:${ownerId}, model: ${model}`,
                error,
            );
            throw error;
        }
    }

    /**
     * Get daily usage info for an owner
     */
    async getDailyUsage(authContext: AuthContext): Promise<DailyUsageInfo> {
        const ownerType = toBillingOwnerType(authContext.ownerType);
        const ownerId = authContext.ownerId;
        const dateStr = getUtcDateString();

        const allowanceKey = BILLING_KEYS.allowanceUsed(ownerType, ownerId, dateStr);

        try {
            const [allowanceUsedStr, wallet] = await Promise.all([
                this.redis.getClient().get(allowanceKey),
                this.walletService.getBalance(ownerType, ownerId),
            ]);

            const allowanceUsed = allowanceUsedStr ? parseInt(allowanceUsedStr, 10) : 0;
            const dailyAllowance = authContext.policy.dailyAllowance;

            return {
                allowanceUsed,
                allowanceRemaining: Math.max(0, dailyAllowance - allowanceUsed),
                walletBalanceCents: wallet.balanceCents.toString(),
                walletLocked: wallet.isLocked,
            };
        } catch (error) {
            this.logger.error(`Failed to get daily usage for ${ownerType}:${ownerId}`, error);
            // Return conservative defaults on error
            return {
                allowanceUsed: 0,
                allowanceRemaining: 0,
                walletBalanceCents: '0',
                walletLocked: true,
            };
        }
    }

    /**
     * Check if an owner can make a request (without charging)
     * Used for pre-flight checks
     */
    async canMakeRequest(authContext: AuthContext, model: string): Promise<{
        allowed: boolean;
        reason?: string;
        source?: 'allowance' | 'wallet';
    }> {
        const ownerType = toBillingOwnerType(authContext.ownerType);
        const ownerId = authContext.ownerId;
        const dateStr = getUtcDateString();

        // Check wallet lock first
        const lockedKey = BILLING_KEYS.walletLocked(ownerType, ownerId);
        const isLocked = await this.redis.getClient().get(lockedKey);
        if (isLocked === '1') {
            return {
                allowed: false,
                reason: 'Account is locked due to a payment dispute',
            };
        }

        // Check allowance
        const allowanceKey = BILLING_KEYS.allowanceUsed(ownerType, ownerId, dateStr);
        const allowanceUsedStr = await this.redis.getClient().get(allowanceKey);
        const allowanceUsed = allowanceUsedStr ? parseInt(allowanceUsedStr, 10) : 0;

        if (allowanceUsed < authContext.policy.dailyAllowance) {
            return { allowed: true, source: 'allowance' };
        }

        // Check wallet if allowance exhausted
        if (!authContext.policy.hasWalletAccess) {
            return {
                allowed: false,
                reason: 'Daily allowance depleted and wallet access not available on your plan',
            };
        }

        const pricing = await this.pricingService.getModelPricing(model);
        const wallet = await this.walletService.getBalance(ownerType, ownerId);

        if (wallet.balanceCents < BigInt(pricing.priceCents)) {
            return {
                allowed: false,
                reason: 'Daily allowance depleted and insufficient wallet balance',
            };
        }

        return { allowed: true, source: 'wallet' };
    }

    /**
     * Check if a request ID has already been billed (idempotency check)
     */
    async isBilled(
        ownerType: 'user' | 'org',
        ownerId: string,
        requestId: string,
    ): Promise<boolean> {
        const idemKey = BILLING_KEYS.billingIdempotency(ownerType, ownerId, requestId);
        const exists = await this.redis.getClient().exists(idemKey);
        return exists === 1;
    }
}