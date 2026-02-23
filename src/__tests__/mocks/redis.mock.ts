/**
 * Reusable Redis mock factory for unit tests
 */
export function createMockRedisClient() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    incr: jest.fn().mockResolvedValue(1),
    incrby: jest.fn().mockResolvedValue(1),
    decrby: jest.fn().mockResolvedValue(0),
    decr: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(-1),
    mget: jest.fn().mockResolvedValue([]),
    mset: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(null),
    evalsha: jest.fn().mockResolvedValue(null),
    script: jest.fn().mockResolvedValue('mock-sha'),
    keys: jest.fn().mockResolvedValue([]),
    scan: jest.fn().mockResolvedValue(['0', []]),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
  };
}

export function createMockRedisService() {
  const mockClient = createMockRedisClient();

  return {
    getClient: jest.fn().mockReturnValue(mockClient),
    isHealthy: jest.fn().mockResolvedValue(true),
    safeBigInt: jest.fn((value: string | number | null) => {
      if (value === null) return BigInt(0);
      return BigInt(String(value));
    }),
    evalLua: jest.fn().mockResolvedValue(null),
    mget: jest.fn().mockResolvedValue([]),
    mset: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(false),
    incr: jest.fn().mockResolvedValue(1),
    incrby: jest.fn().mockResolvedValue(BigInt(1)),
    decrby: jest.fn().mockResolvedValue(BigInt(0)),
    expire: jest.fn().mockResolvedValue(true),
    getTtl: jest.fn().mockResolvedValue(-1),
    deleteByPattern: jest.fn().mockResolvedValue(0),
    _client: mockClient,
  };
}

export type MockRedisClient = ReturnType<typeof createMockRedisClient>;
export type MockRedisService = ReturnType<typeof createMockRedisService>;
