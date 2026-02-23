import { Test, TestingModule } from '@nestjs/testing';
import { ModelPricingService } from '../model-pricing.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

describe('ModelPricingService', () => {
  let service: ModelPricingService;
  let prismaService: jest.Mocked<PrismaService>;
  let redisService: jest.Mocked<RedisService>;

  const mockRedisClient = {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    incrby: jest.fn(),
    decrby: jest.fn(),
    keys: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelPricingService,
        {
          provide: PrismaService,
          useValue: {
            modelRequestPricing: {
              findFirst: jest.fn(),
            },
            modelCatalog: {
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: RedisService,
          useValue: {
            getClient: jest.fn().mockReturnValue(mockRedisClient),
            evalLua: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ModelPricingService>(ModelPricingService);
    prismaService = module.get(PrismaService) as jest.Mocked<PrismaService>;
    redisService = module.get(RedisService) as jest.Mocked<RedisService>;
  });

  describe('getModelPricing', () => {
    const mockPricing = {
      modelId: 'gpt-4',
      priceCents: 5,
      inputPricePer1M: 1000,
      outputPricePer1M: 2000,
    };

    it('should return from memory cache when available', async () => {
      // First call: loads from DB and caches
      mockRedisClient.get.mockResolvedValue(null);
      (
        prismaService.modelRequestPricing.findFirst as jest.Mock
      ).mockResolvedValue({
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
        model: { modelId: 'gpt-4' },
      });
      mockRedisClient.setex.mockResolvedValue('OK');

      await service.getModelPricing('gpt-4');

      // Second call: should use memory cache, no Redis/DB calls
      mockRedisClient.get.mockClear();
      (
        prismaService.modelRequestPricing.findFirst as jest.Mock
      ).mockClear();

      const result = await service.getModelPricing('gpt-4');

      expect(result.modelId).toBe('gpt-4');
      expect(mockRedisClient.get).not.toHaveBeenCalled();
      expect(
        prismaService.modelRequestPricing.findFirst,
      ).not.toHaveBeenCalled();
    });

    it('should return from Redis cache on memory miss', async () => {
      mockRedisClient.get.mockResolvedValue(JSON.stringify(mockPricing));

      const result = await service.getModelPricing('gpt-4');

      expect(result).toEqual(mockPricing);
      expect(mockRedisClient.get).toHaveBeenCalledWith('pricing:gpt-4');
      expect(
        prismaService.modelRequestPricing.findFirst,
      ).not.toHaveBeenCalled();
    });

    it('should load from DB on cache miss', async () => {
      mockRedisClient.get.mockResolvedValue(null); // Redis miss

      (
        prismaService.modelRequestPricing.findFirst as jest.Mock
      ).mockResolvedValue({
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
        model: { modelId: 'gpt-4' },
      });

      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getModelPricing('gpt-4');

      expect(result.modelId).toBe('gpt-4');
      expect(result.priceCents).toBeGreaterThanOrEqual(1);
      expect(prismaService.modelRequestPricing.findFirst).toHaveBeenCalled();
      // Should cache the result in Redis
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        'pricing:gpt-4',
        expect.any(Number),
        expect.any(String),
      );
    });

    it('should return default pricing when no DB record', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      (
        prismaService.modelRequestPricing.findFirst as jest.Mock
      ).mockResolvedValue(null); // No pricing record

      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.getModelPricing('unknown-model');

      expect(result).toEqual({
        modelId: 'unknown-model',
        priceCents: 1, // default 1 cent
        inputPricePer1M: 100,
        outputPricePer1M: 200,
      });
    });
  });

  describe('invalidatePricingCache', () => {
    it('should clear memory and Redis cache', async () => {
      // First, populate memory cache
      mockRedisClient.get.mockResolvedValue(
        JSON.stringify({
          modelId: 'gpt-4',
          priceCents: 5,
          inputPricePer1M: 1000,
          outputPricePer1M: 2000,
        }),
      );
      await service.getModelPricing('gpt-4');

      mockRedisClient.del.mockResolvedValue(1);

      await service.invalidatePricingCache('gpt-4');

      expect(mockRedisClient.del).toHaveBeenCalledWith('pricing:gpt-4');

      // After invalidation, next call should not use memory cache
      mockRedisClient.get.mockResolvedValue(null);
      (
        prismaService.modelRequestPricing.findFirst as jest.Mock
      ).mockResolvedValue(null);
      mockRedisClient.setex.mockResolvedValue('OK');

      await service.getModelPricing('gpt-4');

      // Should hit Redis (which misses) and then DB
      expect(mockRedisClient.get).toHaveBeenCalledWith('pricing:gpt-4');
    });
  });

  describe('invalidateAllPricingCaches', () => {
    it('should clear all caches', async () => {
      // Populate memory cache
      mockRedisClient.get.mockResolvedValue(
        JSON.stringify({
          modelId: 'gpt-4',
          priceCents: 5,
          inputPricePer1M: 1000,
          outputPricePer1M: 2000,
        }),
      );
      await service.getModelPricing('gpt-4');

      mockRedisClient.keys.mockResolvedValue([
        'pricing:gpt-4',
        'pricing:claude-3',
      ]);
      mockRedisClient.del.mockResolvedValue(2);

      await service.invalidateAllPricingCaches();

      expect(mockRedisClient.keys).toHaveBeenCalledWith('pricing:*');
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        'pricing:gpt-4',
        'pricing:claude-3',
      );

      // After clearing, next call should go to Redis again
      mockRedisClient.get.mockClear();
      mockRedisClient.get.mockResolvedValue(null);
      (
        prismaService.modelRequestPricing.findFirst as jest.Mock
      ).mockResolvedValue(null);
      mockRedisClient.setex.mockResolvedValue('OK');

      await service.getModelPricing('gpt-4');

      expect(mockRedisClient.get).toHaveBeenCalledWith('pricing:gpt-4');
    });

    it('should handle empty key list gracefully', async () => {
      mockRedisClient.keys.mockResolvedValue([]);

      await service.invalidateAllPricingCaches();

      expect(mockRedisClient.keys).toHaveBeenCalledWith('pricing:*');
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
  });
});
