import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WalletTxType } from '@prisma/client';
import {
    WalletChargeParams,
    WalletTopupParams,
    WalletRefundParams,
    BILLING_KEYS,
    BILLING_CONSTANTS,
} from './interfaces/billing.interfaces';

/**
 * Wallet Service
 * Handles all wallet mutations with SYNCHRONOUS database writes (v1.7.3 requirement)
 * Redis is hot cache, Postgres is source of truth
 */
@Injectable()
export class WalletService {
    private readonly logger = new Logger(WalletService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) { }

    /**
     * Get wallet balance (from Redis cache with DB fallback)
     */
    async getBalance(
        ownerType: 'user' | 'org',
        ownerId: string,
    ): Promise<{ balanceCents: bigint; isLocked: boolean }> {
        const balanceKey = BILLING_KEYS.walletBalance(ownerType, ownerId);
        const lockedKey = BILLING_KEYS.walletLocked(ownerType, ownerId);

        try {
            const [balanceStr, lockedStr] = await Promise.all([
                this.redis.getClient().get(balanceKey),
                this.redis.getClient().get(lockedKey),
            ]);

            if (balanceStr !== null) {
                return {
                    balanceCents: BigInt(String(balanceStr)),
                    isLocked: lockedStr === '1',
                };
            }

            // Cache miss - load from database and bootstrap Redis
            return this.bootstrapWalletCache(ownerType, ownerId);
        } catch (error) {
            this.logger.error(`Failed to get wallet balance for ${ownerType}:${ownerId}`, error);
            // Fallback to database
            return this.loadWalletFromDb(ownerType, ownerId);
        }
    }

    /**
     * Bootstrap wallet cache from database (v1.7.7 cold start fix)
     */
    async bootstrapWalletCache(
        ownerType: 'user' | 'org',
        ownerId: string,
    ): Promise<{ balanceCents: bigint; isLocked: boolean }> {
        const wallet = await this.loadWalletFromDb(ownerType, ownerId);

        const balanceKey = BILLING_KEYS.walletBalance(ownerType, ownerId);
        const lockedKey = BILLING_KEYS.walletLocked(ownerType, ownerId);

        try {
            // Set balance in Redis (no TTL - always available)
            await this.redis.getClient().set(balanceKey, wallet.balanceCents.toString());

            // Set lock status if locked
            if (wallet.isLocked) {
                await this.redis.getClient().set(lockedKey, '1');
            } else {
                await this.redis.getClient().del(lockedKey);
            }
        } catch (error) {
            this.logger.error(`Failed to bootstrap wallet cache for ${ownerType}:${ownerId}`, error);
        }

        return wallet;
    }

    /**
     * Load wallet from database
     */
    private async loadWalletFromDb(
        ownerType: 'user' | 'org',
        ownerId: string,
    ): Promise<{ balanceCents: bigint; isLocked: boolean }> {
        const whereClause =
            ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId };

        const wallet = await this.prisma.walletBalance.findUnique({
            where: whereClause,
            select: { balanceCents: true, isLocked: true },
        });

        return {
            balanceCents: wallet?.balanceCents ?? BigInt(0),
            isLocked: wallet?.isLocked ?? false,
        };
    }

    /**
     * Record wallet charge to database (SYNCHRONOUS - v1.7.3)
     * Called AFTER billing.lua has already mutated Redis
     * 
     * @param params Charge parameters including the new balance from Lua
     * @returns Success status and new balance
     */
    async recordCharge(params: WalletChargeParams): Promise<{ success: boolean; newBalance: bigint }> {
        const { ownerType, ownerId, amountCents, requestId, model, newBalanceFromLua: _newBalanceFromLua } = params;

        const whereClause =
            ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId };

        try {
            const result = await this.prisma.$transaction(async (tx) => {
                // Update balance (sync with Lua's result)
                const wallet = await tx.walletBalance.update({
                    where: whereClause,
                    data: {
                        balanceCents: { decrement: BigInt(amountCents) },
                        totalSpentCents: { increment: BigInt(amountCents) },
                    },
                });

                // Write ledger entry (append-only)
                await tx.walletLedger.create({
                    data: {
                        userId: ownerType === 'user' ? ownerId : null,
                        organizationId: ownerType === 'org' ? ownerId : null,
                        txType: WalletTxType.CHARGE,
                        amountCents: BigInt(-amountCents), // Negative for charge
                        balanceAfter: wallet.balanceCents,
                        requestId,
                        description: `API request: ${model}`,
                    },
                });

                return wallet;
            });

            return { success: true, newBalance: result.balanceCents };
        } catch (error) {
            this.logger.error(
                `Failed to record charge for ${ownerType}:${ownerId}, requestId: ${requestId}`,
                error,
            );
            throw error;
        }
    }

    /**
     * Add balance to wallet (top-up)
     * SYNCHRONOUS database write, then Redis update
     */
    async addBalance(params: WalletTopupParams): Promise<{ newBalance: bigint }> {
        const { ownerType, ownerId, amountCents, referenceType, referenceId, description } = params;

        // Validate max balance constraint (BigInt safety - v1.7.6)
        const current = await this.getBalance(ownerType, ownerId);
        const projectedBalance = current.balanceCents + BigInt(amountCents);

        if (projectedBalance > BILLING_CONSTANTS.MAX_WALLET_BALANCE_CENTS) {
            throw new Error(
                `Wallet balance would exceed maximum allowed (${BILLING_CONSTANTS.MAX_WALLET_BALANCE_CENTS}). ` +
                `Current: ${current.balanceCents}, Adding: ${amountCents}`,
            );
        }

        const whereClause =
            ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId };

        const result = await this.prisma.$transaction(async (tx) => {
            // Upsert wallet balance
            const wallet = await tx.walletBalance.upsert({
                where: whereClause,
                create: {
                    userId: ownerType === 'user' ? ownerId : null,
                    organizationId: ownerType === 'org' ? ownerId : null,
                    balanceCents: BigInt(amountCents),
                    totalTopupCents: BigInt(amountCents),
                },
                update: {
                    balanceCents: { increment: BigInt(amountCents) },
                    totalTopupCents: { increment: BigInt(amountCents) },
                },
            });

            // Write ledger entry
            await tx.walletLedger.create({
                data: {
                    userId: ownerType === 'user' ? ownerId : null,
                    organizationId: ownerType === 'org' ? ownerId : null,
                    txType: WalletTxType.TOPUP,
                    amountCents: BigInt(amountCents),
                    balanceAfter: wallet.balanceCents,
                    stripePaymentId: referenceType === 'stripe_session' ? referenceId : null,
                    description: description || `Top-up: $${(amountCents / 100).toFixed(2)}`,
                },
            });

            return wallet;
        });

        // Update Redis cache using INCRBY (race-safe - v1.7.6)
        const balanceKey = BILLING_KEYS.walletBalance(ownerType, ownerId);
        try {
            await this.redis.getClient().incrby(balanceKey, amountCents);
        } catch (error) {
            this.logger.error(`Failed to update Redis cache for ${ownerType}:${ownerId}`, error);
            // Redis will be reconciled on next read
        }

        this.logger.log(`Wallet top-up: ${ownerType}:${ownerId} +$${(amountCents / 100).toFixed(2)}`);

        return { newBalance: result.balanceCents };
    }

    /**
     * Refund wallet (TTFB=0 failures)
     * SYNCHRONOUS database write
     */
    async refund(params: WalletRefundParams): Promise<{ success: boolean; newBalance: bigint }> {
        const { ownerType, ownerId, amountCents, requestId, reason } = params;

        if (amountCents <= 0) {
            return { success: false, newBalance: BigInt(0) };
        }

        const whereClause =
            ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId };

        try {
            const result = await this.prisma.$transaction(async (tx) => {
                // Increment balance
                const wallet = await tx.walletBalance.update({
                    where: whereClause,
                    data: {
                        balanceCents: { increment: BigInt(amountCents) },
                    },
                });

                // Write ledger entry
                await tx.walletLedger.create({
                    data: {
                        userId: ownerType === 'user' ? ownerId : null,
                        organizationId: ownerType === 'org' ? ownerId : null,
                        txType: WalletTxType.REFUND,
                        amountCents: BigInt(amountCents), // Positive for refund
                        balanceAfter: wallet.balanceCents,
                        requestId,
                        description: `Refund: ${reason}`,
                    },
                });

                return wallet;
            });

            // Update Redis cache using INCRBY
            const balanceKey = BILLING_KEYS.walletBalance(ownerType, ownerId);
            try {
                await this.redis.getClient().incrby(balanceKey, amountCents);
            } catch (error) {
                this.logger.error(`Failed to update Redis for refund ${ownerType}:${ownerId}`, error);
            }

            this.logger.log(
                `Wallet refund: ${ownerType}:${ownerId} +$${(amountCents / 100).toFixed(2)} (${reason})`,
            );

            return { success: true, newBalance: result.balanceCents };
        } catch (error) {
            this.logger.error(
                `Failed to refund wallet for ${ownerType}:${ownerId}, requestId: ${requestId}`,
                error,
            );
            return { success: false, newBalance: BigInt(0) };
        }
    }

    /**
     * Lock wallet (for disputes/chargebacks)
     */
    async lockWallet(
        ownerType: 'user' | 'org',
        ownerId: string,
        reason: string,
        disputeId?: string,
    ): Promise<void> {
        const whereClause =
            ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId };

        await this.prisma.$transaction(async (tx) => {
            const wallet = await tx.walletBalance.update({
                where: whereClause,
                data: {
                    isLocked: true,
                    lockedReason: reason,
                    lockedAt: new Date(),
                },
            });

            // Log to ledger
            await tx.walletLedger.create({
                data: {
                    userId: ownerType === 'user' ? ownerId : null,
                    organizationId: ownerType === 'org' ? ownerId : null,
                    txType: WalletTxType.ADMIN_ADJUSTMENT,
                    amountCents: BigInt(0),
                    balanceAfter: wallet.balanceCents,
                    stripePaymentId: disputeId,
                    description: `Wallet locked: ${reason}`,
                },
            });
        });

        // Set lock flag in Redis
        const lockedKey = BILLING_KEYS.walletLocked(ownerType, ownerId);
        await this.redis.getClient().set(lockedKey, '1');

        this.logger.warn(`Wallet locked: ${ownerType}:${ownerId} - ${reason}`);
    }

    /**
     * Unlock wallet
     */
    async unlockWallet(
        ownerType: 'user' | 'org',
        ownerId: string,
        reason: string,
    ): Promise<void> {
        const whereClause =
            ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId };

        await this.prisma.$transaction(async (tx) => {
            const wallet = await tx.walletBalance.update({
                where: whereClause,
                data: {
                    isLocked: false,
                    lockedReason: null,
                    lockedAt: null,
                },
            });

            // Log to ledger
            await tx.walletLedger.create({
                data: {
                    userId: ownerType === 'user' ? ownerId : null,
                    organizationId: ownerType === 'org' ? ownerId : null,
                    txType: WalletTxType.ADMIN_ADJUSTMENT,
                    amountCents: BigInt(0),
                    balanceAfter: wallet.balanceCents,
                    description: `Wallet unlocked: ${reason}`,
                },
            });
        });

        // Remove lock flag from Redis
        const lockedKey = BILLING_KEYS.walletLocked(ownerType, ownerId);
        await this.redis.getClient().del(lockedKey);

        this.logger.log(`Wallet unlocked: ${ownerType}:${ownerId} - ${reason}`);
    }

    /**
     * Rollback Redis on database failure (recovery)
     */
    async rollbackRedis(
        ownerType: 'user' | 'org',
        ownerId: string,
        amountCents: number,
    ): Promise<void> {
        const balanceKey = BILLING_KEYS.walletBalance(ownerType, ownerId);
        try {
            await this.redis.getClient().incrby(balanceKey, amountCents);
            this.logger.warn(`Redis rollback: ${ownerType}:${ownerId} +${amountCents} cents`);
        } catch (error) {
            this.logger.error(`Failed to rollback Redis for ${ownerType}:${ownerId}`, error);
        }
    }

    /**
     * Reconcile Redis with database (periodic job)
     */
    async reconcile(ownerType: 'user' | 'org', ownerId: string): Promise<void> {
        const dbWallet = await this.loadWalletFromDb(ownerType, ownerId);
        const balanceKey = BILLING_KEYS.walletBalance(ownerType, ownerId);

        await this.redis.getClient().set(balanceKey, dbWallet.balanceCents.toString());

        // Update last reconciled timestamp
        const whereClause =
            ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId };

        await this.prisma.walletBalance.update({
            where: whereClause,
            data: { lastReconciledAt: new Date() },
        });
    }
}