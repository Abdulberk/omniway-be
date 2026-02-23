import { Test, TestingModule } from '@nestjs/testing';
import { PolicyService } from '../policy.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ApiKeyOwnerType } from '@prisma/client';

describe('PolicyService', () => {
  let service: PolicyService;
  let prismaService: jest.Mocked<PrismaService>;
  let redisService: jest.Mocked<RedisService>;

  const mockRedisClient = {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };

  const mockSubscription = {
    id: 'sub_123',
    userId: 'user_123',
    organizationId: null,
    planId: 'plan_pro',
    status: 'ACTIVE',
    plan: {
      id: 'plan_pro',
      slug: 'pro',
      name: 'Pro Plan',
      limitPerMinute: 60,
      limitPerHour: 600,
      limitPerDay: 5000,
      dailyAllowance: 1000,
      maxConcurrent: 10,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
      maxBodyBytes: 10485760,
      allowedModels: [],
      hasWalletAccess: true,
      hasStreaming: true,
      hasPriorityQueue: false,
    },
  };

  const mockWallet = {
    balanceCents: BigInt(5000),
    isLocked: false,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyService,
        {
          provide: PrismaService,
          useValue: {
            subscription: {
              findUnique: jest.fn(),
              findFirst: jest.fn(),
            },
            walletBalance: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: RedisService,
          useValue: {
            getClient: jest.fn().mockReturnValue(mockRedisClient),
          },
        },
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
    prismaService = module.get(PrismaService) as jest.Mocked<PrismaService>;
    redisService = module.get(RedisService) as jest.Mocked<RedisService>;
  });

  describe('getPolicy', () => {
    it('should return cached policy from Redis', async () => {
      const cachedPolicy = {
        planId: 'plan_pro',
        planSlug: 'pro',
        limitPerMinute: 60,
        limitPerHour: 600,
        limitPerDay: 5000,
        dailyAllowance: 1000,
        maxConcurrent: 10,
        maxInputTokens: 128000,
        maxOutputTokens: 16000,
        maxBodyBytes: 10485760,
        allowedModels: [],
        hasWalletAccess: true,
        hasStreaming: true,
        hasPriorityQueue: false,
        subscriptionStatus: 'ACTIVE',
        subscriptionEndsAt: null,
        walletEnabled: true,
        walletLocked: false,
      };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedPolicy));

      const result = await service.getPolicy(ApiKeyOwnerType.USER, 'user_123');

      expect(result).toEqual(cachedPolicy);
      expect(mockRedisClient.get).toHaveBeenCalled();
      expect(prismaService.subscription.findUnique).not.toHaveBeenCalled();
    });

    it('should load from DB on cache miss', async () => {
      mockRedisClient.get.mockResolvedValue(null); // Cache miss

      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue(
        mockSubscription,
      );
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue(
        mockWallet,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getPolicy(ApiKeyOwnerType.USER, 'user_123');

      expect(result).toMatchObject({
        planId: 'plan_pro',
        planSlug: 'pro',
        limitPerMinute: 60,
        subscriptionStatus: 'ACTIVE',
        walletEnabled: true,
        walletLocked: false,
      });
      expect(prismaService.subscription.findUnique).toHaveBeenCalled();
      // Should cache the result
      expect(mockRedisClient.setex).toHaveBeenCalled();
    });

    it('should return default free policy when no subscription', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getPolicy(ApiKeyOwnerType.USER, 'user_123');

      expect(result).toMatchObject({
        planId: 'plan_free_default',
        planSlug: 'free',
        limitPerMinute: 10,
        limitPerHour: 50,
        limitPerDay: 100,
        dailyAllowance: 100,
        hasWalletAccess: false,
        subscriptionStatus: 'none',
      });
    });

    it('should return default policy for CANCELED subscription', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue({
        ...mockSubscription,
        status: 'CANCELED',
      });
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getPolicy(ApiKeyOwnerType.USER, 'user_123');

      expect(result).toMatchObject({
        planSlug: 'free',
        subscriptionStatus: 'none',
        hasWalletAccess: false,
      });
    });

    it('should handle TRIALING subscription as active', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue({
        ...mockSubscription,
        status: 'TRIALING',
      });
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue(
        mockWallet,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getPolicy(ApiKeyOwnerType.USER, 'user_123');

      expect(result).toMatchObject({
        planId: 'plan_pro',
        subscriptionStatus: 'TRIALING',
        limitPerMinute: 60,
        hasWalletAccess: true,
      });
    });

    it('should handle PAST_DUE subscription as active', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue({
        ...mockSubscription,
        status: 'PAST_DUE',
      });
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue(
        mockWallet,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getPolicy(ApiKeyOwnerType.USER, 'user_123');

      expect(result).toMatchObject({
        planId: 'plan_pro',
        subscriptionStatus: 'PAST_DUE',
        limitPerMinute: 60,
        hasWalletAccess: true,
      });
    });

    it('should include wallet info', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue(
        mockSubscription,
      );
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue({
        balanceCents: BigInt(10000),
        isLocked: true,
      });
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getPolicy(ApiKeyOwnerType.USER, 'user_123');

      expect(result).toMatchObject({
        walletEnabled: true,
        walletLocked: true,
      });
    });

    it('should handle organization owner type', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue({
        ...mockSubscription,
        userId: null,
        organizationId: 'org_123',
      });
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue(
        mockWallet,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getPolicy(
        ApiKeyOwnerType.PROJECT,
        'org_123',
      );

      expect(result).toMatchObject({
        planId: 'plan_pro',
        subscriptionStatus: 'ACTIVE',
      });
      expect(prismaService.subscription.findUnique).toHaveBeenCalledWith({
        where: { organizationId: 'org_123' },
        include: { plan: true },
      });
    });
  });

  describe('invalidatePolicyCache', () => {
    it('should delete Redis key', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      await service.invalidatePolicyCache(ApiKeyOwnerType.USER, 'user_123');

      expect(mockRedisClient.del).toHaveBeenCalledWith(
        expect.stringContaining('policy:user:user_123'),
      );
    });
  });

  describe('bootstrapPolicy', () => {
    it('should load from DB and cache', async () => {
      (prismaService.subscription.findUnique as jest.Mock).mockResolvedValue(
        mockSubscription,
      );
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue(
        mockWallet,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.bootstrapPolicy(
        ApiKeyOwnerType.USER,
        'user_123',
      );

      expect(result).toMatchObject({
        planId: 'plan_pro',
        subscriptionStatus: 'ACTIVE',
      });
      expect(mockRedisClient.setex).toHaveBeenCalled();
    });
  });
});
