import { Test, TestingModule } from '@nestjs/testing';
import { RateLimitService } from '../rate-limit.service';
import { RedisService } from '../../../redis/redis.service';

jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('-- mock lua'),
}));

describe('RateLimitService', () => {
  let service: RateLimitService;
  let redisService: jest.Mocked<RedisService>;

  const authContext = {
    apiKeyId: 'key_123',
    keyPrefix: 'omni_test',
    ownerType: 'USER' as any,
    ownerId: 'user_123',
    scopes: ['chat:write'],
    allowedModels: [],
    allowedIps: [],
    policy: {
      planId: 'plan_pro',
      planSlug: 'pro',
      limitPerMinute: 20,
      limitPerHour: 100,
      limitPerDay: 500,
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
    },
  };

  beforeEach(async () => {
    const mockRedisClient = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitService,
        {
          provide: RedisService,
          useValue: {
            getClient: jest.fn().mockReturnValue(mockRedisClient),
            evalLua: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RateLimitService>(RateLimitService);
    redisService = module.get(RedisService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkRateLimit', () => {
    it('should allow request when under limits', async () => {
      const resetAt = Date.now() + 60000;
      redisService.evalLua.mockResolvedValue([1, 19, 99, 499, resetAt, 'none']);

      const result = await service.checkRateLimit(authContext);

      expect(result).toEqual({
        allowed: true,
        minuteRemaining: 19,
        hourRemaining: 99,
        dayRemaining: 499,
        resetAt,
        limitedBy: 'none',
      });
      expect(redisService.evalLua).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.stringContaining('key_123')]),
        expect.arrayContaining([20, 100, 500, expect.any(Number)]),
      );
    });

    it('should reject when minute limit exceeded', async () => {
      const resetAt = Date.now() + 60000;
      redisService.evalLua.mockResolvedValue([0, 0, 99, 499, resetAt, 'minute']);

      const result = await service.checkRateLimit(authContext);

      expect(result).toEqual({
        allowed: false,
        minuteRemaining: 0,
        hourRemaining: 99,
        dayRemaining: 499,
        resetAt,
        limitedBy: 'minute',
      });
    });

    it('should reject when hour limit exceeded', async () => {
      const resetAt = Date.now() + 3600000;
      redisService.evalLua.mockResolvedValue([0, 19, 0, 499, resetAt, 'hour']);

      const result = await service.checkRateLimit(authContext);

      expect(result).toEqual({
        allowed: false,
        minuteRemaining: 19,
        hourRemaining: 0,
        dayRemaining: 499,
        resetAt,
        limitedBy: 'hour',
      });
    });

    it('should reject when day limit exceeded', async () => {
      const resetAt = Date.now() + 86400000;
      redisService.evalLua.mockResolvedValue([0, 19, 99, 0, resetAt, 'day']);

      const result = await service.checkRateLimit(authContext);

      expect(result).toEqual({
        allowed: false,
        minuteRemaining: 19,
        hourRemaining: 99,
        dayRemaining: 0,
        resetAt,
        limitedBy: 'day',
      });
    });

    it('should fail open (allow) on Redis error', async () => {
      redisService.evalLua.mockRejectedValue(new Error('Redis connection failed'));

      const result = await service.checkRateLimit(authContext);

      expect(result.allowed).toBe(true);
      expect(result.minuteRemaining).toBe(authContext.policy.limitPerMinute);
      expect(result.hourRemaining).toBe(authContext.policy.limitPerHour);
      expect(result.dayRemaining).toBe(authContext.policy.limitPerDay);
    });
  });

  describe('acquireConcurrency', () => {
    it('should allow when slots available', async () => {
      redisService.evalLua.mockResolvedValue([1, 3, 10]);

      const result = await service.acquireConcurrency(authContext, 'req_123');

      expect(result).toEqual({
        allowed: true,
        currentCount: 3,
        maxCount: 10,
      });
      expect(redisService.evalLua).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.stringContaining('key_123')]),
        expect.arrayContaining(['acquire', 'req_123', 10, expect.any(Number)]),
      );
    });

    it('should reject when at capacity', async () => {
      redisService.evalLua.mockResolvedValue([0, 10, 10]);

      const result = await service.acquireConcurrency(authContext, 'req_123');

      expect(result).toEqual({
        allowed: false,
        currentCount: 10,
        maxCount: 10,
      });
    });

    it('should fail open on Redis error', async () => {
      redisService.evalLua.mockRejectedValue(new Error('Redis connection failed'));

      const result = await service.acquireConcurrency(authContext, 'req_123');

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
      expect(result.maxCount).toBe(authContext.policy.maxConcurrent);
    });
  });

  describe('releaseConcurrency', () => {
    it('should call evalLua with release action', async () => {
      redisService.evalLua.mockResolvedValue([1, 2, 10]);

      await service.releaseConcurrency(authContext, 'req_123');

      expect(redisService.evalLua).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.stringContaining('key_123')]),
        expect.arrayContaining(['release', 'req_123', expect.any(Number), expect.any(Number)]),
      );
    });
  });

  describe('getCurrentUsage', () => {
    it('should return usage counts from Redis', async () => {
      const mockRedisClient = {
        get: jest.fn()
          .mockResolvedValueOnce('15') // minute
          .mockResolvedValueOnce('75') // hour
          .mockResolvedValueOnce('350'), // day
      };
      redisService.getClient.mockReturnValue(mockRedisClient as any);

      const result = await service.getCurrentUsage(authContext);

      expect(result).toEqual({
        minuteUsed: 15,
        hourUsed: 75,
        dayUsed: 350,
        minuteLimit: 20,
        hourLimit: 100,
        dayLimit: 500,
      });
      expect(mockRedisClient.get).toHaveBeenCalledTimes(3);
    });
  });
});
