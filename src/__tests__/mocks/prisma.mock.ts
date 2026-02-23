/**
 * Reusable Prisma mock factory for unit tests
 */
export function createMockPrismaService() {
  const mockPrisma: any = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    apiKey: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    subscription: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    walletBalance: {
      findUnique: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    walletLedger: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    modelCatalog: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    modelRequestPricing: {
      findFirst: jest.fn(),
    },
    requestEvent: {
      create: jest.fn(),
    },
    usageDaily: {
      upsert: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: any) => Promise<any>): any =>
      callback(mockPrisma),
    ),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    safeBigInt: jest.fn((value: string | number | bigint) => {
      if (typeof value === 'bigint') return value;
      return BigInt(String(value));
    }),
    isSafeInteger: jest.fn(
      (value: bigint) => value <= BigInt(Number.MAX_SAFE_INTEGER),
    ),
  };

  return mockPrisma;
}

export type MockPrismaService = ReturnType<typeof createMockPrismaService>;
