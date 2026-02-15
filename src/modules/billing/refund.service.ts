import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { WalletService } from './wallet.service';
import {
    WalletRefundParams,
    BILLING_KEYS,
    BILLING_CONSTANTS,
    getUtcDateString,
    secondsUntilUtcMidnight,
} from './interfaces/billing.interfaces';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Refund result from Lua script
 */
export interface RefundResult {
    /**
     * 'SUCCESS' = refund processed
     * 'ALREADY_REFUNDED' = idempotency hit (same requestId already refunded)
     * 'DAILY_CAP_EXCEEDED' = owner exceeded daily refund cap
     * 'NO_CHARGE' = nothing to refund (allowance was used, not wallet)
     * 'ERROR' = unexpected error
     */
    status: 'SUCCESS' | 'ALREADY_REFUNDED' | 'DAILY_CAP_EXCEEDED' | 'NO_CHARGE' | 'ERROR';

    /**
     * New wallet balance after refund (if successful)
     */
    newBalanceCents?: bigint;

    /**
     * Error message if status is ERROR
     */
    error?: string;
}

/**
 * Refund context for processing
 */
export interface RefundContext {
    ownerType: 'user' | 'org';
    ownerId: string;
    requestId: string;
    amountCents: number;
    reason: string;
    /**
     * Was this request charged from wallet (not allowance)?
     * Only wallet charges are refundable
     */
    wasWalletCharge: boolean;
}

/**
 * Refund Service
 * Handles atomic refunds with daily cap and idempotency using Lua script
 */
@Injectable()
export class RefundService {
    private readonly logger = new Logger(RefundService.name);
    private refundLuaScript: string;
    private refundScriptSha: string | null = null;

    constructor(
        private readonly redis: RedisService,
        private readonly walletService: WalletService,
    ) {
        // Load Lua script at startup
        this.loadLuaScript();
    }

    /**
     * Load the refund Lua script from file
     */
    private loadLuaScript(): void {
        try {
            const scriptPath = path.join(__dirname, 'lua', 'refund.lua');
            this.refundLuaScript = fs.readFileSync(scriptPath, 'utf8');
            this.logger.log('Refund Lua script loaded successfully');
        } catch (error) {
            this.logger.error('Failed to load refund Lua script', error);
            throw error;
        }
    }

    /**
     * Load script into Redis and get SHA (for EVALSHA)
     */
    private async ensureScriptLoaded(): Promise<string> {
        if (this.refundScriptSha) {
            return this.refundScriptSha;
        }

        // ioredis uses script('LOAD', script) instead of scriptLoad
        const sha = await this.redis.getClient().script('LOAD', this.refundLuaScript) as string;
        this.refundScriptSha = sha;
        this.logger.log(`Refund Lua script loaded with SHA: ${sha}`);
        return sha;
    }

    /**
     * Process a refund for upstream failure (TTFB=0)
     * 
     * Flow:
     * 1. Check if was wallet charge (allowance charges aren't refundable)
     * 2. Execute Lua script for atomic refund with daily cap + idempotency
     * 3. Record to database (sync write)
     * 4. Return result
     */
    async processRefund(context: RefundContext): Promise<RefundResult> {
        const { ownerType, ownerId, requestId, amountCents, reason, wasWalletCharge } = context;

        // Only wallet charges are refundable
        if (!wasWalletCharge) {
            this.logger.debug(
                `Skipping refund for ${ownerType}:${ownerId} request ${requestId} - was allowance, not wallet`,
            );
            return { status: 'NO_CHARGE' };
        }

        if (amountCents <= 0) {
            return { status: 'NO_CHARGE' };
        }

        try {
            // Execute atomic refund via Lua
            const luaResult = await this.executeRefundLua(ownerType, ownerId, requestId, amountCents);

            if (luaResult === -1) {
                this.logger.debug(`Refund already processed for request ${requestId}`);
                return { status: 'ALREADY_REFUNDED' };
            }

            if (luaResult === -2) {
                this.logger.warn(
                    `Daily refund cap exceeded for ${ownerType}:${ownerId}, request ${requestId}`,
                );
                return { status: 'DAILY_CAP_EXCEEDED' };
            }

            // Lua returned new balance - refund successful in Redis
            const newBalanceCents = BigInt(String(luaResult));

            // Now record to database (sync write)
            const refundParams: WalletRefundParams = {
                ownerType,
                ownerId,
                amountCents,
                requestId,
                reason,
            };

            try {
                await this.recordRefundToDb(refundParams, newBalanceCents);
            } catch (dbError) {
                // DB write failed - rollback Redis
                this.logger.error(
                    `DB write failed for refund ${requestId}, rolling back Redis`,
                    dbError,
                );
                await this.rollbackRefund(ownerType, ownerId, requestId, amountCents);
                return {
                    status: 'ERROR',
                    error: 'Database write failed, refund rolled back',
                };
            }

            this.logger.log(
                `Refund processed: ${ownerType}:${ownerId} +$${(amountCents / 100).toFixed(2)} ` +
                `(request: ${requestId}, reason: ${reason})`,
            );

            return {
                status: 'SUCCESS',
                newBalanceCents,
            };
        } catch (error) {
            this.logger.error(`Refund failed for ${ownerType}:${ownerId} request ${requestId}`, error);
            return {
                status: 'ERROR',
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Execute the refund Lua script
     * 
     * Returns:
     * -1 = already refunded (idempotency hit)
     * -2 = daily cap exceeded
     * positive = new wallet balance
     */
    private async executeRefundLua(
        ownerType: 'user' | 'org',
        ownerId: string,
        requestId: string,
        amountCents: number,
    ): Promise<number> {
        const dateStr = getUtcDateString();
        const ttlSeconds = secondsUntilUtcMidnight();

        // Build Redis keys
        const idempotencyKey = BILLING_KEYS.refundIdempotency(ownerType, ownerId, requestId);
        const refundCountKey = BILLING_KEYS.refundCount(ownerType, ownerId, dateStr);
        const walletKey = BILLING_KEYS.walletBalance(ownerType, ownerId);

        const keys = [idempotencyKey, refundCountKey, walletKey];
        const args = [
            amountCents.toString(),
            BILLING_CONSTANTS.DAILY_REFUND_CAP.toString(),
            ttlSeconds.toString(),
            BILLING_CONSTANTS.IDEMPOTENCY_TTL_SECONDS.toString(),
            requestId,
        ];

        try {
            // Try EVALSHA first
            const sha = await this.ensureScriptLoaded();
            const result = await this.redis.getClient().evalsha(sha, keys.length, ...keys, ...args);
            return Number(result);
        } catch (error: unknown) {
            // If script not found, reload and retry with EVAL
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('NOSCRIPT')) {
                this.refundScriptSha = null;
                const result = await this.redis.getClient().eval(
                    this.refundLuaScript,
                    keys.length,
                    ...keys,
                    ...args,
                );
                return Number(result);
            }
            throw error;
        }
    }

    /**
     * Record refund to database
     * This is a sync write that happens after Redis mutation
     */
    private async recordRefundToDb(
        params: WalletRefundParams,
        _expectedBalance: bigint,
    ): Promise<void> {
        // Use wallet service's refund method for DB write
        // Note: The wallet service will also try to update Redis,
        // but since we already did that in Lua, it's just an idempotent update
        const result = await this.walletService.refund(params);

        if (!result.success) {
            throw new Error('Wallet refund DB write returned failure');
        }
    }

    /**
     * Rollback refund in Redis on DB failure
     */
    private async rollbackRefund(
        ownerType: 'user' | 'org',
        ownerId: string,
        requestId: string,
        amountCents: number,
    ): Promise<void> {
        const dateStr = getUtcDateString();
        const idempotencyKey = BILLING_KEYS.refundIdempotency(ownerType, ownerId, requestId);
        const refundCountKey = BILLING_KEYS.refundCount(ownerType, ownerId, dateStr);
        const walletKey = BILLING_KEYS.walletBalance(ownerType, ownerId);

        const client = this.redis.getClient();

        try {
            // Delete idempotency key to allow retry
            await client.del(idempotencyKey);

            // Decrement refund count
            await client.decr(refundCountKey);

            // Subtract amount from wallet
            await client.decrby(walletKey, amountCents);

            this.logger.warn(
                `Refund rollback completed: ${ownerType}:${ownerId} request ${requestId}`,
            );
        } catch (error) {
            // Critical: Redis rollback failed - log for manual intervention
            this.logger.error(
                `CRITICAL: Refund rollback failed for ${ownerType}:${ownerId} request ${requestId}. ` +
                `Manual intervention required. Amount: ${amountCents}`,
                error,
            );
        }
    }

    /**
     * Get daily refund count for an owner
     */
    async getDailyRefundCount(ownerType: 'user' | 'org', ownerId: string): Promise<number> {
        const dateStr = getUtcDateString();
        const refundCountKey = BILLING_KEYS.refundCount(ownerType, ownerId, dateStr);

        const count = await this.redis.getClient().get(refundCountKey);
        return count ? parseInt(count, 10) : 0;
    }

    /**
     * Check if owner can still receive refunds today
     */
    async canReceiveRefund(ownerType: 'user' | 'org', ownerId: string): Promise<boolean> {
        const count = await this.getDailyRefundCount(ownerType, ownerId);
        return count < BILLING_CONSTANTS.DAILY_REFUND_CAP;
    }
}