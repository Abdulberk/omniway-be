import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ModelPricing } from './interfaces/billing.interfaces';

/**
 * Service for managing model request pricing
 * Uses caching to avoid database hits on hot path
 */
@Injectable()
export class ModelPricingService {
  private readonly logger = new Logger(ModelPricingService.name);
  
  // Local cache TTL (5 minutes)
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  
  // Redis cache TTL (10 minutes)
  private readonly REDIS_CACHE_TTL_SECONDS = 600;
  
  // In-memory cache
  private pricingCache: Map<string, { pricing: ModelPricing; expiresAt: number }> = new Map();
  
  // Default pricing per request (in cents) - fallback if model not found
  private readonly DEFAULT_PRICE_CENTS = 1; // 1 cent per request

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Get pricing for a model
   * Uses multi-level cache: memory -> Redis -> database
   */
  async getModelPricing(modelId: string): Promise<ModelPricing> {
    // Check memory cache first
    const cached = this.pricingCache.get(modelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.pricing;
    }

    // Check Redis cache
    const redisKey = `pricing:${modelId}`;
    const redisCached = await this.redis.getClient().get(redisKey);
    if (redisCached) {
      try {
        const pricing = JSON.parse(redisCached) as ModelPricing;
        this.pricingCache.set(modelId, {
          pricing,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        });
        return pricing;
      } catch {
        // Invalid cache, continue to database
      }
    }

    // Load from database
    const pricing = await this.loadPricingFromDb(modelId);
    
    // Cache in both levels
    await this.cachePricing(modelId, pricing);
    
    return pricing;
  }

  /**
   * Load pricing from database
   */
  private async loadPricingFromDb(modelId: string): Promise<ModelPricing> {
    try {
      // Get the current effective pricing for this model
      const now = new Date();
      
      const pricing = await this.prisma.modelRequestPricing.findFirst({
        where: {
          model: {
            modelId: modelId,
          },
          effectiveFrom: { lte: now },
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gt: now } },
          ],
        },
        orderBy: {
          effectiveFrom: 'desc',
        },
        include: {
          model: true,
        },
      });

      if (!pricing) {
        this.logger.warn(`No pricing found for model ${modelId}, using default`);
        return this.getDefaultPricing(modelId);
      }

      // Calculate per-request price based on average token usage
      // For simplicity, we use input price per 1M tokens / 1000 requests
      // This assumes ~1000 tokens per request average
      const avgTokensPerRequest = 1000;
      const inputCostPerRequest = (pricing.inputPricePer1M / 1_000_000) * avgTokensPerRequest;
      const outputCostPerRequest = (pricing.outputPricePer1M / 1_000_000) * avgTokensPerRequest;
      
      // Total cost in cents, minimum 1 cent
      const priceCents = Math.max(1, Math.ceil(inputCostPerRequest + outputCostPerRequest));

      return {
        modelId,
        priceCents,
        inputPricePer1M: pricing.inputPricePer1M,
        outputPricePer1M: pricing.outputPricePer1M,
      };
    } catch (error) {
      this.logger.error(`Failed to load pricing for model ${modelId}`, error);
      return this.getDefaultPricing(modelId);
    }
  }

  /**
   * Get default pricing for unknown models
   */
  private getDefaultPricing(modelId: string): ModelPricing {
    return {
      modelId,
      priceCents: this.DEFAULT_PRICE_CENTS,
      inputPricePer1M: 100, // $0.001 per 1K tokens
      outputPricePer1M: 200, // $0.002 per 1K tokens
    };
  }

  /**
   * Cache pricing in memory and Redis
   */
  private async cachePricing(modelId: string, pricing: ModelPricing): Promise<void> {
    // Memory cache
    this.pricingCache.set(modelId, {
      pricing,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    // Redis cache
    const redisKey = `pricing:${modelId}`;
    try {
      await this.redis.getClient().setex(
        redisKey,
        this.REDIS_CACHE_TTL_SECONDS,
        JSON.stringify(pricing),
      );
    } catch (error) {
      this.logger.error(`Failed to cache pricing in Redis for ${modelId}`, error);
    }
  }

  /**
   * Invalidate pricing cache (call when pricing changes)
   */
  async invalidatePricingCache(modelId: string): Promise<void> {
    this.pricingCache.delete(modelId);
    const redisKey = `pricing:${modelId}`;
    try {
      await this.redis.getClient().del(redisKey);
    } catch (error) {
      this.logger.error(`Failed to invalidate pricing cache for ${modelId}`, error);
    }
  }

  /**
   * Invalidate all pricing caches
   */
  async invalidateAllPricingCaches(): Promise<void> {
    this.pricingCache.clear();
    try {
      // Get all pricing keys and delete them
      const keys = await this.redis.getClient().keys('pricing:*');
      if (keys.length > 0) {
        await this.redis.getClient().del(...keys);
      }
    } catch (error) {
      this.logger.error('Failed to invalidate all pricing caches', error);
    }
  }

  /**
   * Preload pricing for all active models (startup optimization)
   */
  async preloadAllPricing(): Promise<void> {
    try {
      const models = await this.prisma.modelCatalog.findMany({
        where: { isActive: true },
        select: { modelId: true },
      });

      this.logger.log(`Preloading pricing for ${models.length} models`);

      await Promise.all(
        models.map((model) => this.getModelPricing(model.modelId)),
      );

      this.logger.log('Pricing preload complete');
    } catch (error) {
      this.logger.error('Failed to preload pricing', error);
    }
  }
}