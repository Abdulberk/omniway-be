import { Test, TestingModule } from '@nestjs/testing';
import { RefundService, RefundContext } from '../refund.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletService } from '../wallet.service';
import { BILLING_CONSTANTS } from '../interfaces/billing.interfaces';

// Mock fs module before importing the service
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue('-- mock refund lua'),
}));

describe('RefundService', () => {
  let service: RefundService;
  let redisService: jest.Mocked<RedisService>;
  let walletService: jest.Mocked<WalletService>;

  const mockRedisClient = {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    incrby: jest.fn(),
    decrby: jest.fn(),
    decr: jest.fn(),
    keys: jest.fn(),
    eval: jest.fn(),
    evalsha: jest.fn(),
    script: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundService,
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
            refund: jest.fn(),
            rollbackRedis: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RefundService>(RefundService);
    redisService = module.get(RedisService) as jest.Mocked<RedisService>;
    walletService = module.get(WalletService) as jest.Mocked<WalletService>;
  });

  const createRefundContext = (
    overrides: Partial<RefundContext> = {},
  ): RefundContext => ({
    ownerType: 'user',
    ownerId: 'user-123',
    requestId: 'req-123',
    amountCents: 5,
    reason: 'upstream failure',
    wasWalletCharge: true,
    ...overrides,
  });

  describe('processRefund', () => {
    it('should return NO_CHARGE for non-wallet charges', async () => {
      const context = createRefundContext({ wasWalletCharge: false });

      const result = await service.processRefund(context);

      expect(result).toEqual({ status: 'NO_CHARGE' });
      expect(mockRedisClient.evalsha).not.toHaveBeenCalled();
      expect(mockRedisClient.eval).not.toHaveBeenCalled();
    });

    it('should return NO_CHARGE for zero amount', async () => {
      const context = createRefundContext({ amountCents: 0 });

      const result = await service.processRefund(context);

      expect(result).toEqual({ status: 'NO_CHARGE' });
    });

    it('should return ALREADY_REFUNDED when Lua returns -1', async () => {
      const context = createRefundContext();

      // Mock script load + evalsha returning -1
      mockRedisClient.script.mockResolvedValue('mock-sha');
      mockRedisClient.evalsha.mockResolvedValue(-1);

      const result = await service.processRefund(context);

      expect(result).toEqual({ status: 'ALREADY_REFUNDED' });
      expect(walletService.refund).not.toHaveBeenCalled();
    });

    it('should return DAILY_CAP_EXCEEDED when Lua returns -2', async () => {
      const context = createRefundContext();

      mockRedisClient.script.mockResolvedValue('mock-sha');
      mockRedisClient.evalsha.mockResolvedValue(-2);

      const result = await service.processRefund(context);

      expect(result).toEqual({ status: 'DAILY_CAP_EXCEEDED' });
      expect(walletService.refund).not.toHaveBeenCalled();
    });

    it('should process successful refund and record to DB', async () => {
      const context = createRefundContext();

      // Lua returns new balance (positive number = success)
      mockRedisClient.script.mockResolvedValue('mock-sha');
      mockRedisClient.evalsha.mockResolvedValue(10005);

      walletService.refund.mockResolvedValue({
        success: true,
        newBalance: BigInt(10005),
      });

      const result = await service.processRefund(context);

      expect(result).toEqual({
        status: 'SUCCESS',
        newBalanceCents: BigInt(10005),
      });
      expect(walletService.refund).toHaveBeenCalledWith({
        ownerType: 'user',
        ownerId: 'user-123',
        amountCents: 5,
        requestId: 'req-123',
        reason: 'upstream failure',
      }, {
        syncRedis: false,
      });
    });

    it('should rollback on DB failure', async () => {
      const context = createRefundContext();

      mockRedisClient.script.mockResolvedValue('mock-sha');
      mockRedisClient.evalsha.mockResolvedValue(10005);

      walletService.refund.mockResolvedValue({
        success: false,
        newBalance: BigInt(0),
      });

      const result = await service.processRefund(context);

      expect(result).toEqual({
        status: 'ERROR',
        error: 'Database write failed, refund rolled back',
      });
      // Verify rollback was performed (del idempotency, decr count, decrby wallet)
      expect(mockRedisClient.del).toHaveBeenCalled();
      expect(mockRedisClient.decr).toHaveBeenCalled();
      expect(mockRedisClient.decrby).toHaveBeenCalled();
    });
  });

  describe('getDailyRefundCount', () => {
    it('should return count from Redis', async () => {
      mockRedisClient.get.mockResolvedValue('7');

      const count = await service.getDailyRefundCount('user', 'user-123');

      expect(count).toBe(7);
    });

    it('should return 0 when no key exists', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const count = await service.getDailyRefundCount('user', 'user-123');

      expect(count).toBe(0);
    });
  });

  describe('canReceiveRefund', () => {
    it('should return true when under cap', async () => {
      mockRedisClient.get.mockResolvedValue('5');

      const result = await service.canReceiveRefund('user', 'user-123');

      expect(result).toBe(true);
    });

    it('should return false when at cap', async () => {
      mockRedisClient.get.mockResolvedValue(
        BILLING_CONSTANTS.DAILY_REFUND_CAP.toString(),
      );

      const result = await service.canReceiveRefund('user', 'user-123');

      expect(result).toBe(false);
    });
  });
});
