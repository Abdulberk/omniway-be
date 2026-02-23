/**
 * Reusable ConfigService mock factory for unit tests
 */

const DEFAULT_CONFIG: Record<string, any> = {
  NODE_ENV: 'test',
  PORT: 3000,
  HOST: '0.0.0.0',
  CORS_ORIGINS: '*',
  LOG_LEVEL: 'error',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret-must-be-at-least-32-characters',
  JWT_EXPIRES_IN: '7d',
  STRIPE_SECRET_KEY: 'sk_test_xxx',
  STRIPE_WEBHOOK_SECRET: 'whsec_xxx',
  UPSTREAM_API_KEY: 'sk-test-upstream',
  UPSTREAM_OPENAI_URL: 'https://api.test.com/openai',
  UPSTREAM_ANTHROPIC_URL: 'https://api.test.com/anthropic',
  UPSTREAM_OPENAI_COMPATIBLE_URL: 'https://api.test.com/openai-compatible',
  DEFAULT_LIMIT_PER_MINUTE: 20,
  DEFAULT_LIMIT_PER_HOUR: 100,
  DEFAULT_LIMIT_PER_DAY: 500,
  DEFAULT_MAX_CONCURRENT: 5,
  GLOBAL_MAX_CONCURRENT: 1000,
  GLOBAL_MAX_RPS: 500,
  UPSTREAM_CONNECT_TIMEOUT_MS: 5000,
  UPSTREAM_READ_TIMEOUT_MS: 120000,
  STREAM_MAX_DURATION_MS: 300000,
  MAX_BODY_BYTES: 10485760,
  MAX_INPUT_TOKENS: 128000,
  MAX_OUTPUT_TOKENS: 16000,
  CIRCUIT_BREAKER_THRESHOLD: 50,
  CIRCUIT_BREAKER_RESET_MS: 30000,
};

export function createMockConfigService(overrides: Record<string, any> = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };

  return {
    get: jest.fn((key: string, defaultValue?: any) => {
      return key in config ? config[key] : defaultValue;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in config)) {
        throw new Error(`Config key "${key}" not found`);
      }
      return config[key];
    }),
  };
}

export type MockConfigService = ReturnType<typeof createMockConfigService>;
