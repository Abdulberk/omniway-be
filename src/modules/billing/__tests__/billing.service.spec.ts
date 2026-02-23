import { Test, TestingModule } from '@nestjs/testing';
import { BillingService } from '../billing.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletService } from '../wallet.service';
import { ModelPricingService } from '../model-pricing.service';
import { AuthContext } from '../../auth/interfaces/auth.interfaces';
import { ApiKeyOwnerType } from '@prisma/client';

// Mock fs module before importing the service
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('-- mock lua script'),
}));

describe('BillingService', () => {
  let service: BillingService;
  let redisService: jest.Mocked<RedisService>;
  let walletService: jest.Mocked<WalletService>;
  let pricingService: jest.Mocked<ModelPricingService>;

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

  const mockAuthContext: AuthContext = {
    apiKeyId: 'key-123',
    keyPrefix: 'omni_test1234',
    ownerId: 'user-123',
    ownerType: ApiKeyOwnerType.USER,
    scopes: ['chat:write'],
    allowedModels: [],
    allowedIps: [],
    policy: {
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
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        {
          provide: RedisService,
          useValue: {
            getClient: jest.fn().mockReturnValue(mockRedisClient),
            evalLua: jest.fn(),
          },
        },
        {
          provide: WalletService,
          useValue: {
            getBalance: jest.fn(),
            recordCharge: jest.fn(),
            rollbackRedis: jest.fn(),
          },
        },
        {
          provide: ModelPricingService,
          useValue: {
            getModelPricing: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
    redisService = module.get(RedisService) as jest.Mocked<RedisService>;
    walletService = module.get(WalletService) as jest.Mocked<WalletService>;
    pricingService = module.get(
      ModelPricingService,
    ) as jest.Mocked<ModelPricingService>;
  });

  describe('chargeBilling', () => {
    it('should execute Lua script and return allowance result', async () => {
      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      // Mock Lua script returning success with allowance
      redisService.evalLua.mockResolvedValue([1, 'allowance', 0, 999, '10000']);

      const result = await service.chargeBilling(
        mockAuthContext,
        'req-123',
        'gpt-4',
      );

      expect(result).toEqual({
        code: 1,
        source: 'allowance',
        chargedCents: 0,
        allowanceRemaining: 999,
        walletBalanceCents: '10000',
      });
      expect(redisService.evalLua).toHaveBeenCalled();
      expect(walletService.recordCharge).not.toHaveBeenCalled();
    });

    it('should return wallet charge result and record to DB', async () => {
      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      // Mock Lua script returning success with wallet charge
      redisService.evalLua.mockResolvedValue([1, 'wallet', 5, 0, '9995']);

      walletService.recordCharge.mockResolvedValue({
        success: true,
        newBalance: BigInt(9995),
      });

      const result = await service.chargeBilling(
        mockAuthContext,
        'req-123',
        'gpt-4',
      );

      expect(result).toEqual({
        code: 1,
        source: 'wallet',
        chargedCents: 5,
        allowanceRemaining: 0,
        walletBalanceCents: '9995',
      });
      expect(walletService.recordCharge).toHaveBeenCalledWith({
        ownerType: 'user',
        ownerId: 'user-123',
        amountCents: 5,
        requestId: 'req-123',
        model: 'gpt-4',
        newBalanceFromLua: BigInt(9995),
      });
    });

    it('should handle idempotent hit (code=2)', async () => {
      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      // Mock Lua script returning idempotent hit
      redisService.evalLua.mockResolvedValue([2, 'allowance', 0, 999, '10000']);

      const result = await service.chargeBilling(
        mockAuthContext,
        'req-123',
        'gpt-4',
      );

      expect(result).toEqual({
        code: 2,
        source: 'allowance',
        chargedCents: 0,
        allowanceRemaining: 999,
        walletBalanceCents: '10000',
      });
      expect(walletService.recordCharge).not.toHaveBeenCalled();
    });

    it('should return insufficient funds when code=0', async () => {
      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      // Mock Lua script returning insufficient funds
      redisService.evalLua.mockResolvedValue([
        0,
        'insufficient_wallet',
        5,
        0,
        '3',
      ]);

      const result = await service.chargeBilling(
        mockAuthContext,
        'req-123',
        'gpt-4',
      );

      expect(result).toEqual({
        code: 0,
        source: 'insufficient_wallet',
        chargedCents: 5,
        allowanceRemaining: 0,
        walletBalanceCents: '3',
      });
      expect(walletService.recordCharge).not.toHaveBeenCalled();
    });

    it('should handle locked wallet', async () => {
      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      // Mock Lua script returning locked wallet
      redisService.evalLua.mockResolvedValue([0, 'locked', 0, 1000, '10000']);

      const result = await service.chargeBilling(
        mockAuthContext,
        'req-123',
        'gpt-4',
      );

      expect(result).toEqual({
        code: 0,
        source: 'locked',
        chargedCents: 0,
        allowanceRemaining: 1000,
        walletBalanceCents: '10000',
      });
      expect(walletService.recordCharge).not.toHaveBeenCalled();
    });

    it('should rollback Redis when DB write fails (wallet charge)', async () => {
      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      // Mock Lua script returning wallet charge
      redisService.evalLua.mockResolvedValue([1, 'wallet', 5, 0, '9995']);

      // Mock DB write failure
      const dbError = new Error('Database connection failed');
      walletService.recordCharge.mockRejectedValue(dbError);

      await expect(
        service.chargeBilling(mockAuthContext, 'req-123', 'gpt-4'),
      ).rejects.toThrow('Database connection failed');

      expect(walletService.rollbackRedis).toHaveBeenCalledWith(
        'user',
        'user-123',
        5,
      );
    });
  });

  describe('getDailyUsage', () => {
    it('should return usage info', async () => {
      mockRedisClient.get.mockResolvedValue('100');
      walletService.getBalance.mockResolvedValue({
        balanceCents: BigInt(5000),
        isLocked: false,
      });

      const result = await service.getDailyUsage(mockAuthContext);

      expect(result).toEqual({
        allowanceUsed: 100,
        allowanceRemaining: 900,
        walletBalanceCents: '5000',
        walletLocked: false,
      });
    });

    it('should return defaults on Redis error', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));
      walletService.getBalance.mockRejectedValue(new Error('Redis error'));

      const result = await service.getDailyUsage(mockAuthContext);

      expect(result).toEqual({
        allowanceUsed: 0,
        allowanceRemaining: 0,
        walletBalanceCents: '0',
        walletLocked: true,
      });
    });
  });

  describe('canMakeRequest', () => {
    it('should allow when allowance available', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null); // lockedKey
      mockRedisClient.get.mockResolvedValueOnce('100'); // allowanceKey

      const result = await service.canMakeRequest(mockAuthContext, 'gpt-4');

      expect(result).toEqual({
        allowed: true,
        source: 'allowance',
      });
    });

    it('should allow when wallet has funds', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null); // lockedKey
      mockRedisClient.get.mockResolvedValueOnce('1000'); // allowanceKey - depleted

      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      walletService.getBalance.mockResolvedValue({
        balanceCents: BigInt(1000),
        isLocked: false,
      });

      const result = await service.canMakeRequest(mockAuthContext, 'gpt-4');

      expect(result).toEqual({
        allowed: true,
        source: 'wallet',
      });
    });

    it('should reject when locked', async () => {
      mockRedisClient.get.mockResolvedValueOnce('1'); // lockedKey

      const result = await service.canMakeRequest(mockAuthContext, 'gpt-4');

      expect(result).toEqual({
        allowed: false,
        reason: 'Account is locked due to a payment dispute',
      });
    });

    it('should reject when allowance depleted and no wallet access', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null); // lockedKey
      mockRedisClient.get.mockResolvedValueOnce('1000'); // allowanceKey - depleted

      const contextNoWallet = {
        ...mockAuthContext,
        policy: { ...mockAuthContext.policy, hasWalletAccess: false },
      };

      const result = await service.canMakeRequest(contextNoWallet, 'gpt-4');

      expect(result).toEqual({
        allowed: false,
        reason:
          'Daily allowance depleted and wallet access not available on your plan',
      });
    });

    it('should reject when insufficient wallet balance', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null); // lockedKey
      mockRedisClient.get.mockResolvedValueOnce('1000'); // allowanceKey - depleted

      pricingService.getModelPricing.mockResolvedValue({
        modelId: 'gpt-4',
        priceCents: 5,
        inputPricePer1M: 1000,
        outputPricePer1M: 2000,
      });

      walletService.getBalance.mockResolvedValue({
        balanceCents: BigInt(3),
        isLocked: false,
      });

      const result = await service.canMakeRequest(mockAuthContext, 'gpt-4');

      expect(result).toEqual({
        allowed: false,
        reason: 'Daily allowance depleted and insufficient wallet balance',
      });
    });
  });

  describe('isBilled', () => {
    it('should check idempotency key existence', async () => {
      mockRedisClient.exists.mockResolvedValue(1);

      const result = await service.isBilled('user', 'user-123', 'req-123');

      expect(result).toBe(true);
      expect(mockRedisClient.exists).toHaveBeenCalled();
    });

    it('should return false when key does not exist', async () => {
      mockRedisClient.exists.mockResolvedValue(0);

      const result = await service.isBilled('user', 'user-123', 'req-123');

      expect(result).toBe(false);
    });
  });
});
