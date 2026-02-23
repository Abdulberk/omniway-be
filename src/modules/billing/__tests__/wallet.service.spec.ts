import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from '../wallet.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxType } from '@prisma/client';
import { BILLING_CONSTANTS } from '../interfaces/billing.interfaces';

describe('WalletService', () => {
  let service: WalletService;
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
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            walletBalance: {
              findUnique: jest.fn(),
              update: jest.fn(),
              upsert: jest.fn(),
            },
            walletLedger: {
              create: jest.fn(),
            },
            $transaction: jest.fn(),
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

    service = module.get<WalletService>(WalletService);
    prismaService = module.get(PrismaService) as jest.Mocked<PrismaService>;
    redisService = module.get(RedisService) as jest.Mocked<RedisService>;
  });

  describe('getBalance', () => {
    it('should return balance from Redis cache', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce('5000') // balanceKey
        .mockResolvedValueOnce(null); // lockedKey

      const result = await service.getBalance('user', 'user-123');

      expect(result).toEqual({
        balanceCents: BigInt(5000),
        isLocked: false,
      });
    });

    it('should bootstrap from DB on cache miss', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce(null) // balanceKey - cache miss
        .mockResolvedValueOnce(null); // lockedKey

      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue({
        balanceCents: BigInt(7500),
        isLocked: false,
      });

      mockRedisClient.set.mockResolvedValue('OK');
      mockRedisClient.del.mockResolvedValue(1);

      const result = await service.getBalance('user', 'user-123');

      expect(result).toEqual({
        balanceCents: BigInt(7500),
        isLocked: false,
      });
      // Verify cache was bootstrapped
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:balance_cents'),
        '7500',
      );
    });

    it('should fallback to DB on Redis error', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('Redis connection lost'));

      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue({
        balanceCents: BigInt(3000),
        isLocked: true,
      });

      const result = await service.getBalance('user', 'user-123');

      expect(result).toEqual({
        balanceCents: BigInt(3000),
        isLocked: true,
      });
    });
  });

  describe('bootstrapWalletCache', () => {
    it('should set Redis keys from DB values', async () => {
      (prismaService.walletBalance.findUnique as jest.Mock).mockResolvedValue({
        balanceCents: BigInt(9000),
        isLocked: true,
      });

      mockRedisClient.set.mockResolvedValue('OK');

      const result = await service.bootstrapWalletCache('user', 'user-123');

      expect(result).toEqual({
        balanceCents: BigInt(9000),
        isLocked: true,
      });
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:balance_cents'),
        '9000',
      );
      // Locked, so should set locked key
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:locked'),
        '1',
      );
    });
  });

  describe('recordCharge', () => {
    it('should decrement balance and create ledger entry', async () => {
      const mockWallet = { balanceCents: BigInt(9995) };

      (prismaService.$transaction as jest.Mock).mockImplementation(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            walletBalance: {
              update: jest.fn().mockResolvedValue(mockWallet),
            },
            walletLedger: {
              create: jest.fn().mockResolvedValue({}),
            },
          };
          return callback(tx);
        },
      );

      const result = await service.recordCharge({
        ownerType: 'user',
        ownerId: 'user-123',
        amountCents: 5,
        requestId: 'req-123',
        model: 'gpt-4',
        newBalanceFromLua: BigInt(9995),
      });

      expect(result).toEqual({
        success: true,
        newBalance: BigInt(9995),
      });
    });

    it('should throw on transaction failure', async () => {
      (prismaService.$transaction as jest.Mock).mockRejectedValue(
        new Error('Transaction failed'),
      );

      await expect(
        service.recordCharge({
          ownerType: 'user',
          ownerId: 'user-123',
          amountCents: 5,
          requestId: 'req-123',
          model: 'gpt-4',
          newBalanceFromLua: BigInt(9995),
        }),
      ).rejects.toThrow('Transaction failed');
    });
  });

  describe('addBalance', () => {
    it('should increment balance with ledger entry', async () => {
      // Mock getBalance for max balance check
      mockRedisClient.get
        .mockResolvedValueOnce('1000') // balanceKey
        .mockResolvedValueOnce(null); // lockedKey

      const mockWallet = { balanceCents: BigInt(2000) };

      (prismaService.$transaction as jest.Mock).mockImplementation(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            walletBalance: {
              upsert: jest.fn().mockResolvedValue(mockWallet),
            },
            walletLedger: {
              create: jest.fn().mockResolvedValue({}),
            },
          };
          return callback(tx);
        },
      );

      mockRedisClient.incrby.mockResolvedValue(2000);

      const result = await service.addBalance({
        ownerType: 'user',
        ownerId: 'user-123',
        amountCents: 1000,
        referenceType: 'stripe_session',
        referenceId: 'cs_123',
      });

      expect(result).toEqual({ newBalance: BigInt(2000) });
    });

    it('should enforce max wallet balance', async () => {
      // Mock getBalance returning near-max balance
      mockRedisClient.get
        .mockResolvedValueOnce(
          BILLING_CONSTANTS.MAX_WALLET_BALANCE_CENTS.toString(),
        )
        .mockResolvedValueOnce(null);

      await expect(
        service.addBalance({
          ownerType: 'user',
          ownerId: 'user-123',
          amountCents: 1,
          referenceType: 'stripe_session',
          referenceId: 'cs_123',
        }),
      ).rejects.toThrow(/exceed maximum/);
    });

    it('should update Redis cache', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce('1000')
        .mockResolvedValueOnce(null);

      const mockWallet = { balanceCents: BigInt(1500) };

      (prismaService.$transaction as jest.Mock).mockImplementation(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            walletBalance: {
              upsert: jest.fn().mockResolvedValue(mockWallet),
            },
            walletLedger: {
              create: jest.fn().mockResolvedValue({}),
            },
          };
          return callback(tx);
        },
      );

      mockRedisClient.incrby.mockResolvedValue(1500);

      await service.addBalance({
        ownerType: 'user',
        ownerId: 'user-123',
        amountCents: 500,
        referenceType: 'manual',
        referenceId: 'ref-123',
      });

      expect(mockRedisClient.incrby).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:balance_cents'),
        500,
      );
    });
  });

  describe('refund', () => {
    it('should increment balance and create REFUND ledger entry', async () => {
      const mockWallet = { balanceCents: BigInt(5500) };

      (prismaService.$transaction as jest.Mock).mockImplementation(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            walletBalance: {
              update: jest.fn().mockResolvedValue(mockWallet),
            },
            walletLedger: {
              create: jest.fn().mockResolvedValue({}),
            },
          };
          return callback(tx);
        },
      );

      mockRedisClient.incrby.mockResolvedValue(5500);

      const result = await service.refund({
        ownerType: 'user',
        ownerId: 'user-123',
        amountCents: 500,
        requestId: 'req-123',
        reason: 'upstream failure',
      });

      expect(result).toEqual({
        success: true,
        newBalance: BigInt(5500),
      });
      expect(mockRedisClient.incrby).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:balance_cents'),
        500,
      );
    });

    it('should return false for zero amount', async () => {
      const result = await service.refund({
        ownerType: 'user',
        ownerId: 'user-123',
        amountCents: 0,
        requestId: 'req-123',
        reason: 'upstream failure',
      });

      expect(result).toEqual({
        success: false,
        newBalance: BigInt(0),
      });
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('lockWallet', () => {
    it('should set lock in DB and Redis', async () => {
      (prismaService.$transaction as jest.Mock).mockImplementation(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            walletBalance: {
              update: jest.fn().mockResolvedValue({ balanceCents: BigInt(5000) }),
            },
            walletLedger: {
              create: jest.fn().mockResolvedValue({}),
            },
          };
          return callback(tx);
        },
      );

      mockRedisClient.set.mockResolvedValue('OK');

      await service.lockWallet('user', 'user-123', 'chargeback dispute');

      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:locked'),
        '1',
      );
    });
  });

  describe('unlockWallet', () => {
    it('should remove lock from DB and Redis', async () => {
      (prismaService.$transaction as jest.Mock).mockImplementation(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            walletBalance: {
              update: jest.fn().mockResolvedValue({ balanceCents: BigInt(5000) }),
            },
            walletLedger: {
              create: jest.fn().mockResolvedValue({}),
            },
          };
          return callback(tx);
        },
      );

      mockRedisClient.del.mockResolvedValue(1);

      await service.unlockWallet('user', 'user-123', 'dispute resolved');

      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:locked'),
      );
    });
  });

  describe('rollbackRedis', () => {
    it('should increment balance back', async () => {
      mockRedisClient.incrby.mockResolvedValue(10005);

      await service.rollbackRedis('user', 'user-123', 5);

      expect(mockRedisClient.incrby).toHaveBeenCalledWith(
        expect.stringContaining('wallet:user:user-123:balance_cents'),
        5,
      );
    });
  });
});
