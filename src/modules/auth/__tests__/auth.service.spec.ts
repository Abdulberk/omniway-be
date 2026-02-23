import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ApiKeyService } from '../api-key.service';
import { PolicyService } from '../policy.service';
import { ApiKeyOwnerType } from '@prisma/client';
import { testPolicy, testApiKeyData, testProjectApiKeyData } from '../../../__tests__/fixtures/auth.fixtures';

describe('AuthService', () => {
  let service: AuthService;
  let prismaService: jest.Mocked<PrismaService>;
  let apiKeyService: jest.Mocked<ApiKeyService>;
  let policyService: jest.Mocked<PolicyService>;

  const mockRequest = {
    headers: {},
    ip: '127.0.0.1',
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            project: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: ApiKeyService,
          useValue: {
            validateApiKey: jest.fn(),
            updateLastUsed: jest.fn(),
          },
        },
        {
          provide: PolicyService,
          useValue: {
            getPolicy: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prismaService = module.get(PrismaService) as jest.Mocked<PrismaService>;
    apiKeyService = module.get(ApiKeyService) as jest.Mocked<ApiKeyService>;
    policyService = module.get(PolicyService) as jest.Mocked<PolicyService>;
  });

  describe('authenticate', () => {
    it('should authenticate with a valid API key', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer omni_test123' },
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testApiKeyData,
      });

      policyService.getPolicy.mockResolvedValue(testPolicy);

      const result = await service.authenticate(request);

      expect(result).toMatchObject({
        apiKeyId: testApiKeyData.id,
        keyPrefix: testApiKeyData.keyPrefix,
        ownerType: ApiKeyOwnerType.USER,
        ownerId: testApiKeyData.userId,
        userId: testApiKeyData.userId,
      });
      expect(result.policy).toEqual(testPolicy);
    });

    it('should throw UnauthorizedException when auth header missing', async () => {
      const request = {
        ...mockRequest,
        headers: {},
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: false,
        reason: 'Missing Authorization header',
      });

      await expect(service.authenticate(request)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException for invalid API key', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer invalid_key' },
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: false,
        reason: 'Invalid API key',
      });

      await expect(service.authenticate(request)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException for expired API key', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer omni_expired' },
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: false,
        reason: 'API key has expired',
      });

      await expect(service.authenticate(request)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException when IP not in allowlist', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer omni_test123' },
        ip: '192.168.1.100',
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testProjectApiKeyData,
      });

      await expect(service.authenticate(request)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.authenticate(request)).rejects.toThrow(
        'IP address not allowed',
      );
    });

    it('should resolve USER owner context correctly', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer omni_test123' },
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testApiKeyData,
      });

      policyService.getPolicy.mockResolvedValue(testPolicy);

      const result = await service.authenticate(request);

      expect(result.ownerType).toBe(ApiKeyOwnerType.USER);
      expect(result.ownerId).toBe(testApiKeyData.userId);
      expect(result.userId).toBe(testApiKeyData.userId);
      expect(result.organizationId).toBeUndefined();
      expect(result.projectId).toBeUndefined();
    });

    it('should resolve PROJECT owner context (lookup org from project)', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer omni_proj123' },
        ip: '10.0.0.1',
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testProjectApiKeyData,
      });

      (prismaService.project.findUnique as jest.Mock).mockResolvedValue({
        organizationId: 'org_test_123',
      });

      policyService.getPolicy.mockResolvedValue(testPolicy);

      const result = await service.authenticate(request);

      expect(result.ownerType).toBe(ApiKeyOwnerType.PROJECT);
      expect(result.ownerId).toBe('org_test_123');
      expect(result.organizationId).toBe('org_test_123');
      expect(result.projectId).toBe(testProjectApiKeyData.projectId);
      expect(result.userId).toBeUndefined();
    });

    it('should throw when project not found for PROJECT key', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer omni_proj123' },
        ip: '10.0.0.1',
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testProjectApiKeyData,
      });

      (prismaService.project.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.authenticate(request)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.authenticate(request)).rejects.toThrow(
        'Project not found',
      );
    });

    it('should extract IP from X-Forwarded-For header', async () => {
      const request = {
        ...mockRequest,
        headers: {
          authorization: 'Bearer omni_test123',
          'x-forwarded-for': '203.0.113.42, 198.51.100.17',
        },
        ip: '127.0.0.1',
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testApiKeyData,
      });

      policyService.getPolicy.mockResolvedValue(testPolicy);

      await service.authenticate(request);

      expect(apiKeyService.updateLastUsed).toHaveBeenCalledWith(
        testApiKeyData.id,
        '203.0.113.42',
      );
    });

    it('should extract IP from X-Real-IP header', async () => {
      const request = {
        ...mockRequest,
        headers: {
          authorization: 'Bearer omni_test123',
          'x-real-ip': '203.0.113.99',
        },
        ip: '127.0.0.1',
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testApiKeyData,
      });

      policyService.getPolicy.mockResolvedValue(testPolicy);

      await service.authenticate(request);

      expect(apiKeyService.updateLastUsed).toHaveBeenCalledWith(
        testApiKeyData.id,
        '203.0.113.99',
      );
    });

    it('should fallback to request.ip when no proxy headers', async () => {
      const request = {
        ...mockRequest,
        headers: { authorization: 'Bearer omni_test123' },
        ip: '192.168.1.50',
      };

      apiKeyService.validateApiKey.mockResolvedValue({
        isValid: true,
        apiKey: testApiKeyData,
      });

      policyService.getPolicy.mockResolvedValue(testPolicy);

      await service.authenticate(request);

      expect(apiKeyService.updateLastUsed).toHaveBeenCalledWith(
        testApiKeyData.id,
        '192.168.1.50',
      );
    });
  });

  describe('hasScope', () => {
    const authContext: any = {
      scopes: ['chat:write', 'embeddings:write'],
    };

    it('should return true for existing scope', () => {
      expect(service.hasScope(authContext, 'chat:write')).toBe(true);
      expect(service.hasScope(authContext, 'embeddings:write')).toBe(true);
    });

    it('should return false for missing scope', () => {
      expect(service.hasScope(authContext, 'admin:write')).toBe(false);
      expect(service.hasScope(authContext, 'chat:read')).toBe(false);
    });
  });

  describe('canAccessModel', () => {
    it('should return true when no restrictions', () => {
      const authContext: any = {
        allowedModels: [],
        policy: {
          allowedModels: [],
        },
      };

      expect(service.canAccessModel(authContext, 'gpt-4')).toBe(true);
      expect(service.canAccessModel(authContext, 'claude-3-opus')).toBe(true);
    });

    it('should check policy restrictions when key has no restrictions', () => {
      const authContext: any = {
        allowedModels: [],
        policy: {
          allowedModels: ['gpt-3.5-turbo', 'claude-3-haiku'],
        },
      };

      expect(service.canAccessModel(authContext, 'gpt-3.5-turbo')).toBe(true);
      expect(service.canAccessModel(authContext, 'gpt-4')).toBe(false);
    });

    it('should check key-level restrictions', () => {
      const authContext: any = {
        allowedModels: ['gpt-4', 'claude-3-sonnet'],
        policy: {
          allowedModels: [],
        },
      };

      expect(service.canAccessModel(authContext, 'gpt-4')).toBe(true);
      expect(service.canAccessModel(authContext, 'claude-3-sonnet')).toBe(
        true,
      );
      expect(service.canAccessModel(authContext, 'gpt-3.5-turbo')).toBe(false);
    });
  });
});
