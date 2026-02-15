import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ModelInfo, ProviderConfig, ModelsListResponse } from './interfaces/gateway.interfaces';

const MODEL_CACHE_TTL = 300; // 5 minutes

@Injectable()
export class ModelService {
  private readonly logger = new Logger(ModelService.name);
  private providerConfigs: Map<string, ProviderConfig> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.initializeProviders();
  }

  /**
   * Initialize provider configurations from environment
   */
  private initializeProviders(): void {
    const upstreamApiKey = this.config.get<string>('UPSTREAM_API_KEY', '');
    const connectTimeout = this.config.get<number>('UPSTREAM_CONNECT_TIMEOUT_MS', 5000);
    const readTimeout = this.config.get<number>('UPSTREAM_READ_TIMEOUT_MS', 120000);

    this.providerConfigs.set('openai', {
      name: 'openai',
      baseUrl: this.config.get<string>('UPSTREAM_OPENAI_URL', 'https://api.o7.team/openai'),
      apiKey: upstreamApiKey,
      timeout: { connect: connectTimeout, read: readTimeout },
    });

    this.providerConfigs.set('anthropic', {
      name: 'anthropic',
      baseUrl: this.config.get<string>('UPSTREAM_ANTHROPIC_URL', 'https://api.o7.team/anthropic'),
      apiKey: upstreamApiKey,
      timeout: { connect: connectTimeout, read: readTimeout },
    });

    this.providerConfigs.set('google', {
      name: 'google',
      baseUrl: this.config.get<string>('UPSTREAM_OPENAI_COMPATIBLE_URL', 'https://api.o7.team/openai-compatible'),
      apiKey: upstreamApiKey,
      timeout: { connect: connectTimeout, read: readTimeout },
    });

    this.logger.log('Provider configurations initialized');
  }

  /**
   * Get provider configuration
   */
  getProvider(providerName: string): ProviderConfig | undefined {
    return this.providerConfigs.get(providerName);
  }

  /**
   * Get model info by ID
   */
  async getModel(modelId: string): Promise<ModelInfo | null> {
    // Check cache first
    const cacheKey = `model:${modelId}`;
    const cached = await this.redis.getClient().get(cacheKey);

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Invalid cache, continue to DB
      }
    }

    // Fetch from database
    const model = await this.prisma.modelCatalog.findUnique({
      where: { modelId },
    });

    if (!model) {
      return null;
    }

    const modelInfo: ModelInfo = {
      modelId: model.modelId,
      provider: model.provider,
      upstreamModelId: model.upstreamModelId,
      displayName: model.displayName,
      supportsStreaming: model.supportsStreaming,
      supportsVision: model.supportsVision,
      supportsToolCalls: model.supportsToolCalls,
      supportsFunctionCall: model.supportsFunctionCall,
      supportsJson: model.supportsJson,
      maxContextTokens: model.maxContextTokens,
      maxOutputTokens: model.maxOutputTokens,
      isActive: model.isActive,
      isDeprecated: model.isDeprecated,
    };

    // Cache it
    await this.redis.getClient().setex(
      cacheKey,
      MODEL_CACHE_TTL,
      JSON.stringify(modelInfo),
    );

    return modelInfo;
  }

  /**
   * Get model info, throw if not found
   */
  async getModelOrThrow(modelId: string): Promise<ModelInfo> {
    const model = await this.getModel(modelId);

    if (!model) {
      throw new NotFoundException({
        error: {
          message: `Model '${modelId}' not found`,
          type: 'invalid_request_error',
          code: 'model_not_found',
          param: 'model',
        },
      });
    }

    if (!model.isActive) {
      throw new NotFoundException({
        error: {
          message: `Model '${modelId}' is not available`,
          type: 'invalid_request_error',
          code: 'model_not_available',
          param: 'model',
        },
      });
    }

    return model;
  }

  /**
   * List all available models (for /v1/models endpoint)
   */
  async listModels(): Promise<ModelsListResponse> {
    // Check cache
    const cacheKey = 'models:list';
    const cached = await this.redis.getClient().get(cacheKey);

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Invalid cache, continue
      }
    }

    // Fetch from database
    const models = await this.prisma.modelCatalog.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    });

    const response: ModelsListResponse = {
      object: 'list',
      data: models.map((model) => ({
        id: model.modelId,
        object: 'model' as const,
        created: Math.floor(model.createdAt.getTime() / 1000),
        owned_by: model.provider,
      })),
    };

    // Cache for shorter time
    await this.redis.getClient().setex(cacheKey, 60, JSON.stringify(response));

    return response;
  }

  /**
   * Get model capabilities (extended info for /v1/models/:id)
   */
  async getModelCapabilities(modelId: string): Promise<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    capabilities: {
      streaming: boolean;
      vision: boolean;
      tool_calls: boolean;
      function_call: boolean;
      json_mode: boolean;
    };
    limits: {
      max_context_tokens: number;
      max_output_tokens: number;
    };
    deprecated: boolean;
  }> {
    const model = await this.getModelOrThrow(modelId);

    return {
      id: model.modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: model.provider,
      capabilities: {
        streaming: model.supportsStreaming,
        vision: model.supportsVision,
        tool_calls: model.supportsToolCalls,
        function_call: model.supportsFunctionCall,
        json_mode: model.supportsJson,
      },
      limits: {
        max_context_tokens: model.maxContextTokens,
        max_output_tokens: model.maxOutputTokens,
      },
      deprecated: model.isDeprecated,
    };
  }

  /**
   * Invalidate model cache
   */
  async invalidateModelCache(modelId?: string): Promise<void> {
    if (modelId) {
      await this.redis.getClient().del(`model:${modelId}`);
    }
    await this.redis.getClient().del('models:list');
  }
}