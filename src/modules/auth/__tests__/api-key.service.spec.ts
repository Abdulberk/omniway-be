import { Test, TestingModule } from '@nestjs/testing';
import { ApiKeyService } from '../api-key.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ApiKeyOwnerType } from '@prisma/client';

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let prismaService: jest.Mocked<PrismaService>;
  let redisService: jest.Mocked<RedisService>;

  const mockRedisClient = {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyService,
        {
          provide: PrismaService,
          useValue: {
            apiKey: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
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

    service = module.get<ApiKeyService>(ApiKeyService);
    prismaService = module.get(PrismaService) as jest.Mocked<PrismaService>;
    redisService = module.get(RedisService) as jest.Mocked<RedisService>;
  });

  describe('generateApiKey', () => {
    it('should return key with omni_ prefix, prefix, and hash', () => {
      const result = service.generateApiKey();

      expect(result.key).toMatch(/^omni_[A-Za-z0-9_-]{32,}$/);
      expect(result.prefix).toMatch(/^omni_[A-Za-z0-9_-]{8}$/);
      expect(result.hash).toHaveLength(64); // SHA256 = 64 hex chars
    });

    it('should generate unique keys on multiple calls', () => {
      const key1 = service.generateApiKey();
      const key2 = service.generateApiKey();

      expect(key1.key).not.toBe(key2.key);
      expect(key1.hash).not.toBe(key2.hash);
    });
  });

  describe('hashKey', () => {
    it('should return consistent SHA256 hash', () => {
      const key = 'omni_test123456789012345678901234';

      const hash1 = service.hashKey(key);
      const hash2 = service.hashKey(key);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('should return different hashes for different keys', () => {
      const hash1 = service.hashKey('omni_test1');
      const hash2 = service.hashKey('omni_test2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('validateApiKey', () => {
    const mockApiKey = {
      id: 'key_123',
      keyPrefix: 'omni_test1234',
      ownerType: ApiKeyOwnerType.USER,
      userId: 'user_123',
      projectId: null,
      scopes: ['chat:write'],
      allowedModels: [],
      allowedIps: [],
      isActive: true,
      expiresAt: null,
      revokedAt: null,
    };

    it('should reject missing auth header', async () => {
      const result = await service.validateApiKey(undefined);

      expect(result).toEqual({
        isValid: false,
        reason: 'Missing Authorization header',
      });
    });

    it('should reject invalid format (not "Bearer xxx")', async () => {
      const result = await service.validateApiKey('InvalidFormat');

      expect(result).toEqual({
        isValid: false,
        reason: 'Invalid Authorization header format',
      });
    });

    it('should reject key not starting with omni_', async () => {
      const result = await service.validateApiKey('Bearer sk_test123');

      expect(result).toEqual({
        isValid: false,
        reason: 'Invalid API key format',
      });
    });

    it('should return cached key if available in Redis', async () => {
      const cachedKey = JSON.stringify(mockApiKey);
      mockRedisClient.get.mockResolvedValue(cachedKey);

      const result = await service.validateApiKey(
        'Bearer omni_test1234567890',
      );

      expect(result).toEqual({
        isValid: true,
        apiKey: mockApiKey,
      });
      expect(mockRedisClient.get).toHaveBeenCalled();
      expect(prismaService.apiKey.findUnique).not.toHaveBeenCalled();
    });

    it('should fetch from DB on cache miss', async () => {
      mockRedisClient.get.mockResolvedValue(null); // Cache miss

      (prismaService.apiKey.findUnique as jest.Mock).mockResolvedValue(
        mockApiKey,
      );
      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.validateApiKey(
        'Bearer omni_test1234567890',
      );

      expect(result).toEqual({
        isValid: true,
        apiKey: expect.objectContaining({
          id: mockApiKey.id,
          keyPrefix: mockApiKey.keyPrefix,
          ownerType: mockApiKey.ownerType,
          userId: mockApiKey.userId,
        }),
      });
      expect(prismaService.apiKey.findUnique).toHaveBeenCalled();
      // Should cache the result
      expect(mockRedisClient.setex).toHaveBeenCalled();
    });

    it('should reject revoked key (revokedAt set)', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      // Revoked keys return null from fetchApiKeyFromDb
      (prismaService.apiKey.findUnique as jest.Mock).mockResolvedValue({
        ...mockApiKey,
        revokedAt: new Date('2024-01-01'),
      });

      const result = await service.validateApiKey(
        'Bearer omni_test1234567890',
      );

      expect(result).toEqual({
        isValid: false,
        reason: 'Invalid API key',
      });
    });

    it('should reject inactive key', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.apiKey.findUnique as jest.Mock).mockResolvedValue({
        ...mockApiKey,
        isActive: false,
        revokedAt: null,
      });

      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.validateApiKey(
        'Bearer omni_test1234567890',
      );

      expect(result).toEqual({
        isValid: false,
        reason: 'API key is inactive',
      });
    });

    it('should reject expired key', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.apiKey.findUnique as jest.Mock).mockResolvedValue({
        ...mockApiKey,
        expiresAt: new Date('2020-01-01'), // Past date
        revokedAt: null,
      });

      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.validateApiKey(
        'Bearer omni_test1234567890',
      );

      expect(result).toEqual({
        isValid: false,
        reason: 'API key has expired',
      });
    });

    it('should accept key with future expiry date', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      (prismaService.apiKey.findUnique as jest.Mock).mockResolvedValue({
        ...mockApiKey,
        expiresAt: new Date('2030-01-01'), // Future date
        revokedAt: null,
      });

      mockRedisClient.setex.mockResolvedValue('OK');

      const result = await service.validateApiKey(
        'Bearer omni_test1234567890',
      );

      expect(result).toEqual({
        isValid: true,
        apiKey: expect.objectContaining({
          id: 'key_123',
        }),
      });
    });
  });

  describe('createUserApiKey', () => {
    it('should create key with USER owner type', async () => {
      const mockCreatedKey = {
        id: 'key_new',
        keyPrefix: 'omni_newkey12',
        keyHash: 'hash123',
        ownerType: ApiKeyOwnerType.USER,
        userId: 'user_123',
        projectId: null,
        scopes: ['chat:write'],
        allowedModels: [],
        allowedIps: [],
        isActive: true,
        expiresAt: null,
      };

      (prismaService.apiKey.create as jest.Mock).mockResolvedValue(
        mockCreatedKey,
      );

      const result = await service.createUserApiKey(
        'user_123',
        'Test Key',
        ['chat:write'],
      );

      expect(result).toMatchObject({
        id: 'key_new',
      });
      expect(result.key).toMatch(/^omni_/);
      expect(result.prefix).toBeDefined();
      expect(prismaService.apiKey.create).toHaveBeenCalled();
    });
  });

  describe('revokeApiKey', () => {
    it('should deactivate and invalidate cache', async () => {
      const mockRevokedKey = {
        id: 'key_123',
        keyPrefix: 'omni_test1234',
        keyHash: 'hash123',
        isActive: false,
        revokedAt: new Date(),
      };

      (prismaService.apiKey.update as jest.Mock).mockResolvedValue(
        mockRevokedKey,
      );
      mockRedisClient.del.mockResolvedValue(1);

      await service.revokeApiKey('key_123', 'Security audit');

      expect(prismaService.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'key_123' },
        data: expect.objectContaining({
          isActive: false,
          revokedAt: expect.any(Date),
          revokedReason: 'Security audit',
        }),
      });

      // Should invalidate cache
      expect(mockRedisClient.del).toHaveBeenCalled();
    });
  });

  describe('updateLastUsed', () => {
    it('should update last used timestamp and IP (non-blocking)', async () => {
      (prismaService.apiKey.update as jest.Mock).mockResolvedValue({});

      // This should not throw and should be fire-and-forget
      await service.updateLastUsed('key_123', '203.0.113.42');

      expect(prismaService.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'key_123' },
        data: expect.objectContaining({
          lastUsedAt: expect.any(Date),
          lastUsedIp: '203.0.113.42',
          usageCount: { increment: 1 },
        }),
      });
    });

    it('should not throw on database error', async () => {
      (prismaService.apiKey.update as jest.Mock).mockRejectedValue(
        new Error('DB connection lost'),
      );

      // Should not throw (fire-and-forget)
      await expect(
        service.updateLastUsed('key_123', '127.0.0.1'),
      ).resolves.not.toThrow();
    });
  });
});
