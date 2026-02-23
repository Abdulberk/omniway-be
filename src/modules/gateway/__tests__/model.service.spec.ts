import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ModelService } from '../model.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ConfigService } from '@nestjs/config';

describe('ModelService', () => {
  let service: ModelService;
  let prismaService: jest.Mocked<PrismaService>;
  let redisService: jest.Mocked<RedisService>;
  let configService: jest.Mocked<ConfigService>;
  let mockRedisClient: any;

  const dbModel = {
    modelId: 'gpt-4',
    provider: 'openai',
    upstreamModelId: 'gpt-4-0613',
    displayName: 'GPT-4',
    supportsStreaming: true,
    supportsVision: false,
    supportsToolCalls: true,
    supportsFunctionCall: true,
    supportsJson: true,
    maxContextTokens: 8192,
    maxOutputTokens: 4096,
    isActive: true,
    isDeprecated: false,
    sortOrder: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date(),
  };

  const configDefaults: Record<string, any> = {
    'providers.openai.apiKey': 'sk-test',
    'providers.openai.baseUrl': 'https://api.openai.com/v1',
    'providers.anthropic.apiKey': 'sk-ant-test',
    'providers.anthropic.baseUrl': 'https://api.anthropic.com/v1',
  };

  beforeEach(async () => {
    mockRedisClient = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelService,
        {
          provide: PrismaService,
          useValue: {
            modelCatalog: {
              findUnique: jest.fn(),
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
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              return configDefaults[key as keyof typeof configDefaults] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ModelService>(ModelService);
    prismaService = module.get(PrismaService);
    redisService = module.get(RedisService);
    configService = module.get(ConfigService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getModel', () => {
    it('should return cached model from Redis', async () => {
      const cachedModel = {
        modelId: 'gpt-4',
        provider: 'openai',
        upstreamModelId: 'gpt-4-0613',
        displayName: 'GPT-4',
        supportsStreaming: true,
        supportsVision: false,
        supportsToolCalls: true,
        supportsFunctionCall: true,
        supportsJson: true,
        maxContextTokens: 8192,
        maxOutputTokens: 4096,
        isActive: true,
        isDeprecated: false,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedModel));

      const result = await service.getModel('gpt-4');

      expect(result).toEqual(cachedModel);
      expect(mockRedisClient.get).toHaveBeenCalledWith(
        expect.stringContaining('model:gpt-4'),
      );
      expect(prismaService.model.findUnique).not.toHaveBeenCalled();
    });

    it('should fetch from DB on cache miss and cache result', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      (prismaService.modelCatalog.findUnique as jest.Mock).mockResolvedValue(
        dbModel,
      );

      const result = await service.getModel('gpt-4');

      expect(result).toMatchObject({
        modelId: 'gpt-4',
        provider: 'openai',
        upstreamModelId: 'gpt-4-0613',
        displayName: 'GPT-4',
      });
      expect(prismaService.modelCatalog.findUnique).toHaveBeenCalledWith({
        where: { modelId: 'gpt-4' },
      });
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('model:gpt-4'),
        expect.any(Number),
        expect.any(String),
      );
    });

    it('should return null for non-existent model', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      (prismaService.modelCatalog.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await service.getModel('non-existent');

      expect(result).toBeNull();
      expect(prismaService.modelCatalog.findUnique).toHaveBeenCalledWith({
        where: { modelId: 'non-existent' },
      });
    });
  });

  describe('getModelOrThrow', () => {
    it('should throw NotFoundException for missing model', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      (prismaService.modelCatalog.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      await expect(service.getModelOrThrow('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException for inactive model', async () => {
      const inactiveModel = { ...dbModel, isActive: false };
      mockRedisClient.get.mockResolvedValue(null);
      (prismaService.modelCatalog.findUnique as jest.Mock).mockResolvedValue(
        inactiveModel,
      );

      await expect(service.getModelOrThrow('gpt-4')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listModels', () => {
    it('should return cached list from Redis', async () => {
      const cachedResponse = {
        object: 'list',
        data: [
          {
            id: 'gpt-4',
            object: 'model' as const,
            created: 1704067200,
            owned_by: 'openai',
          },
          {
            id: 'gpt-3.5-turbo',
            object: 'model' as const,
            created: 1704067200,
            owned_by: 'openai',
          },
        ],
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedResponse));

      const result = await service.listModels();

      expect(result).toEqual(cachedResponse);
      expect(mockRedisClient.get).toHaveBeenCalledWith(
        expect.stringContaining('models:list'),
      );
      expect(prismaService.modelCatalog.findMany).not.toHaveBeenCalled();
    });

    it('should fetch from DB on cache miss', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      (prismaService.modelCatalog.findMany as jest.Mock).mockResolvedValue([
        dbModel,
      ]);

      const result = await service.listModels();

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: 'gpt-4',
        object: 'model',
        owned_by: 'openai',
      });
      expect(prismaService.modelCatalog.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      });
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('models:list'),
        expect.any(Number),
        expect.any(String),
      );
    });
  });

  describe('getProvider', () => {
    it('should return provider config by name', () => {
      const provider = service.getProvider('openai');

      expect(provider).toBeDefined();
      expect(provider?.name).toBe('openai');
      expect(provider?.apiKey).toBe('sk-test');
      expect(provider?.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should return undefined for unknown provider', () => {
      const provider = service.getProvider('unknown-provider');

      expect(provider).toBeUndefined();
    });
  });

  describe('invalidateModelCache', () => {
    it('should delete model and list cache', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      await service.invalidateModelCache('gpt-4');

      expect(mockRedisClient.del).toHaveBeenCalledWith(
        expect.stringContaining('model:gpt-4'),
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        expect.stringContaining('models:list'),
      );
      expect(mockRedisClient.del).toHaveBeenCalledTimes(2);
    });
  });
});
