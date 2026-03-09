import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { RedisService } from '../../../redis/redis.service';
import { ConfigService } from '@nestjs/config';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;
  let redisService: jest.Mocked<RedisService>;
  let configService: jest.Mocked<ConfigService>;
  let mockRedisClient: any;

  const configDefaults: Record<string, any> = {
    CIRCUIT_BREAKER_THRESHOLD: 5,
    CIRCUIT_BREAKER_RESET_MS: 30000,
  };

  beforeEach(async () => {
    mockRedisClient = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircuitBreakerService,
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

    service = module.get<CircuitBreakerService>(CircuitBreakerService);
    redisService = module.get(RedisService);
    configService = module.get(ConfigService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('isOpen', () => {
    it('should return false when circuit is closed', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const result = await service.isOpen('openai');

      expect(result).toBe(false);
      expect(mockRedisClient.get).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
      );
    });

    it('should return true when circuit is open and not ready for retry', async () => {
      const circuitState = {
        status: 'open',
        failures: 5,
        lastFailure: Date.now() - 10000,
        nextRetry: Date.now() + 20000,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(circuitState));

      const result = await service.isOpen('openai');

      expect(result).toBe(true);
    });

    it('should return false and transition to half-open when retry time passed', async () => {
      const circuitState = {
        status: 'open',
        failures: 5,
        lastFailure: Date.now() - 40000,
        nextRetry: Date.now() - 10000,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(circuitState));

      const result = await service.isOpen('openai');

      expect(result).toBe(false);
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
        expect.any(Number),
        expect.stringContaining('"status":"half-open"'),
      );
    });
  });

  describe('checkCircuit', () => {
    it('should throw ServiceUnavailableException when open', async () => {
      const circuitState = {
        status: 'open',
        failures: 5,
        lastFailure: Date.now() - 10000,
        nextRetry: Date.now() + 20000,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(circuitState));

      await expect(service.checkCircuit('openai')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('should not throw when closed', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await expect(service.checkCircuit('openai')).resolves.not.toThrow();
    });
  });

  describe('recordSuccess', () => {
    it('should close circuit when in half-open state', async () => {
      const circuitState = {
        status: 'half-open',
        failures: 5,
        lastFailure: Date.now() - 40000,
        nextRetry: null,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(circuitState));

      await service.recordSuccess('openai');

      expect(mockRedisClient.del).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
      );
    });

    it('should do nothing when already closed', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await service.recordSuccess('openai');

      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count when under threshold', async () => {
      const circuitState = {
        status: 'closed',
        failures: 2,
        lastFailure: Date.now() - 5000,
        nextRetry: null,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(circuitState));

      await service.recordFailure('openai');

      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
        expect.any(Number),
        expect.stringMatching(/"failures":3/),
      );
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
        expect.any(Number),
        expect.stringMatching(/"status":"closed"/),
      );
    });

    it('should open circuit when threshold reached', async () => {
      const circuitState = {
        status: 'closed',
        failures: 4,
        lastFailure: Date.now() - 5000,
        nextRetry: null,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(circuitState));

      await service.recordFailure('openai');

      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
        expect.any(Number),
        expect.stringMatching(/"status":"open"/),
      );
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
        expect.any(Number),
        expect.stringMatching(/"failures":5/),
      );
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
        expect.any(Number),
        expect.stringMatching(/"nextRetry":\d+/),
      );
    });

    it('should reopen circuit when in half-open state', async () => {
      const circuitState = {
        status: 'half-open',
        failures: 5,
        lastFailure: Date.now() - 40000,
        nextRetry: null,
      };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(circuitState));

      await service.recordFailure('openai');

      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
        expect.any(Number),
        expect.stringMatching(/"status":"open"/),
      );
    });
  });

  describe('getState', () => {
    it('should return default closed state when no Redis data', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const result = await service.getState('openai');

      expect(result).toEqual({
        status: 'closed',
        failures: 0,
        lastFailure: null,
        nextRetry: null,
      });
    });
  });

  describe('forceReset', () => {
    it('should delete Redis key', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      await service.forceReset('openai');

      expect(mockRedisClient.del).toHaveBeenCalledWith(
        expect.stringContaining('circuit:openai'),
      );
    });
  });

  describe('getAllStates', () => {
    it('should return states for all providers', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          JSON.stringify({
            status: 'open',
            failures: 5,
            lastFailure: Date.now(),
            nextRetry: Date.now() + 30000,
          }),
        )
        .mockResolvedValueOnce(null);

      const result = await service.getAllStates();

      expect(result).toHaveProperty('openai');
      expect(result).toHaveProperty('anthropic');
      expect(result.openai.status).toBe('closed');
      expect(result.anthropic.status).toBe('open');
      expect(mockRedisClient.get).toHaveBeenCalledTimes(3);
    });
  });
});
