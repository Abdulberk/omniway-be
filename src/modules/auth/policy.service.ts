import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  ResolvedPolicy,
  AUTH_CACHE_KEYS,
  AUTH_CACHE_TTL,
} from './interfaces/auth.interfaces';
import { ApiKeyOwnerType, SubscriptionStatus } from '@prisma/client';

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  // Default policy for free tier / no subscription
  private readonly defaultPolicy: ResolvedPolicy = {
    planId: 'plan_free_default',
    planSlug: 'free',
    limitPerMinute: 10,
    limitPerHour: 50,
    limitPerDay: 100,
    dailyAllowance: 100,
    maxConcurrent: 2,
    maxInputTokens: 4000,
    maxOutputTokens: 2000,
    maxBodyBytes: 524288, // 512KB
    allowedModels: ['gpt-3.5-turbo', 'claude-3-haiku'],
    hasWalletAccess: false,
    hasStreaming: true,
    hasPriorityQueue: false,
    subscriptionStatus: 'none',
    subscriptionEndsAt: null,
    walletEnabled: false,
    walletLocked: false,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) { }

  /**
   * Get policy for an owner (user or org)
   * Uses cache with fallback to database
   */
  async getPolicy(
    ownerType: ApiKeyOwnerType,
    ownerId: string,
  ): Promise<ResolvedPolicy> {
    // Normalize owner type for cache key
    const ownerTypeKey = ownerType === ApiKeyOwnerType.USER ? 'user' : 'org';

    // For PROJECT type, we need to get the organization's policy
    // This should be handled by the caller passing the orgId as ownerId

    // Check cache first
    const cached = await this.getCachedPolicy(ownerTypeKey, ownerId);
    if (cached) {
      return cached;
    }

    // Load from database
    const policy = await this.loadPolicyFromDb(ownerType, ownerId);

    // Cache the policy
    await this.cachePolicy(ownerTypeKey, ownerId, policy);

    return policy;
  }

  /**
   * Get cached policy
   */
  private async getCachedPolicy(
    ownerType: string,
    ownerId: string,
  ): Promise<ResolvedPolicy | null> {
    const cacheKey = AUTH_CACHE_KEYS.policy(ownerType, ownerId);
    const cached = await this.redis.getClient().get(cacheKey);

    if (!cached) {
      return null;
    }

    try {
      const policy = JSON.parse(cached);
      // Convert date string back to Date
      if (policy.subscriptionEndsAt) {
        policy.subscriptionEndsAt = new Date(policy.subscriptionEndsAt);
      }
      return policy;
    } catch {
      return null;
    }
  }

  /**
   * Cache policy
   */
  private async cachePolicy(
    ownerType: string,
    ownerId: string,
    policy: ResolvedPolicy,
  ): Promise<void> {
    const cacheKey = AUTH_CACHE_KEYS.policy(ownerType, ownerId);
    await this.redis.getClient().setex(
      cacheKey,
      AUTH_CACHE_TTL.policy,
      JSON.stringify(policy),
    );
  }

  /**
   * Load policy from database based on subscription
   */
  private async loadPolicyFromDb(
    ownerType: ApiKeyOwnerType,
    ownerId: string,
  ): Promise<ResolvedPolicy> {
    // Find subscription based on owner type
    const subscription = await this.findSubscription(ownerType, ownerId);

    if (!subscription || !this.isSubscriptionActive(subscription.status)) {
      this.logger.debug(
        `No active subscription for ${ownerType}:${ownerId}, using default policy`,
      );
      return this.defaultPolicy;
    }

    const plan = subscription.plan;

    // Get wallet info
    const wallet = await this.getWalletInfo(ownerType, ownerId);

    return {
      planId: plan.id,
      planSlug: plan.slug,
      limitPerMinute: plan.limitPerMinute,
      limitPerHour: plan.limitPerHour,
      limitPerDay: plan.limitPerDay,
      dailyAllowance: plan.dailyAllowance,
      maxConcurrent: plan.maxConcurrent,
      maxInputTokens: plan.maxInputTokens,
      maxOutputTokens: plan.maxOutputTokens,
      maxBodyBytes: plan.maxBodyBytes,
      allowedModels: plan.allowedModels.length > 0 ? plan.allowedModels : [],
      hasWalletAccess: plan.hasWalletAccess,
      hasStreaming: plan.hasStreaming,
      hasPriorityQueue: plan.hasPriorityQueue,
      subscriptionStatus: subscription.status,
      subscriptionEndsAt: subscription.currentPeriodEnd,
      walletEnabled: wallet.enabled,
      walletLocked: wallet.locked,
    };
  }

  /**
   * Find subscription for owner
   */
  private async findSubscription(ownerType: ApiKeyOwnerType, ownerId: string) {
    if (ownerType === ApiKeyOwnerType.USER) {
      return this.prisma.subscription.findUnique({
        where: { userId: ownerId },
        include: { plan: true },
      });
    } else {
      // For PROJECT type, ownerId should be the organizationId
      return this.prisma.subscription.findUnique({
        where: { organizationId: ownerId },
        include: { plan: true },
      });
    }
  }

  /**
   * Get wallet info for owner
   */
  private async getWalletInfo(
    ownerType: ApiKeyOwnerType,
    ownerId: string,
  ): Promise<{ enabled: boolean; locked: boolean }> {
    let wallet;

    if (ownerType === ApiKeyOwnerType.USER) {
      wallet = await this.prisma.walletBalance.findUnique({
        where: { userId: ownerId },
        select: { isLocked: true },
      });
    } else {
      wallet = await this.prisma.walletBalance.findUnique({
        where: { organizationId: ownerId },
        select: { isLocked: true },
      });
    }

    return {
      enabled: !!wallet,
      locked: wallet?.isLocked ?? false,
    };
  }

  /**
   * Check if subscription status is considered active
   */
  private isSubscriptionActive(status: SubscriptionStatus): boolean {
    const activeStatuses: SubscriptionStatus[] = [
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
      SubscriptionStatus.PAST_DUE, // Grace period
    ];
    return activeStatuses.includes(status);
  }

  /**
   * Invalidate policy cache (call when subscription/plan changes)
   */
  async invalidatePolicyCache(
    ownerType: ApiKeyOwnerType,
    ownerId: string,
  ): Promise<void> {
    const ownerTypeKey = ownerType === ApiKeyOwnerType.USER ? 'user' : 'org';
    const cacheKey = AUTH_CACHE_KEYS.policy(ownerTypeKey, ownerId);
    await this.redis.getClient().del(cacheKey);
    this.logger.debug(`Invalidated policy cache for ${ownerTypeKey}:${ownerId}`);
  }

  /**
   * Bootstrap Redis with owner's policy (cold start optimization)
   * Call this after subscription changes or on first request
   */
  async bootstrapPolicy(
    ownerType: ApiKeyOwnerType,
    ownerId: string,
  ): Promise<ResolvedPolicy> {
    const policy = await this.loadPolicyFromDb(ownerType, ownerId);
    const ownerTypeKey = ownerType === ApiKeyOwnerType.USER ? 'user' : 'org';
    await this.cachePolicy(ownerTypeKey, ownerId, policy);
    return policy;
  }
}