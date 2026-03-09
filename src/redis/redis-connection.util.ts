import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

/**
 * Build a BullMQ/ioredis-compatible connection object from REDIS_URL.
 */
export function getRedisConnectionOptions(
  configService: ConfigService,
): RedisOptions {
  const redisUrl = configService.get<string>('REDIS_URL');

  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is required');
  }

  const parsed = new URL(redisUrl);
  const db =
    parsed.pathname && parsed.pathname !== '/'
      ? Number.parseInt(parsed.pathname.slice(1), 10)
      : 0;

  return {
    host: parsed.hostname,
    port: parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === 'rediss:'
        ? 6380
        : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}
