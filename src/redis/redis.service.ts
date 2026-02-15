import {
  Injectable,
  Inject,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {
    this.redis.on('connect', () => {
      this.logger.log('Redis client connected');
    });

    this.redis.on('error', (err) => {
      this.logger.error('Redis client error', err);
    });

    this.redis.on('close', () => {
      this.logger.warn('Redis client connection closed');
    });
  }

  async onModuleDestroy() {
    this.logger.log('Disconnecting Redis client...');
    await this.redis.quit();
    this.logger.log('Redis client disconnected');
  }

  /**
   * Get the raw Redis client for direct operations
   */
  getClient(): Redis {
    return this.redis;
  }

  /**
   * Check if Redis is connected and healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Safe BigInt handling for Redis values
   * Always use string conversion to avoid floating-point issues
   */
  safeBigInt(value: string | number | null): bigint {
    if (value === null) {
      return BigInt(0);
    }
    return BigInt(String(value));
  }

  /**
   * Execute a Lua script with proper error handling
   */
  async evalLua<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T> {
    try {
      const result = await this.redis.eval(
        script,
        keys.length,
        ...keys,
        ...args.map(String),
      );
      return result as T;
    } catch (error) {
      this.logger.error('Lua script execution failed', {
        error,
        keysCount: keys.length,
      });
      throw error;
    }
  }

  /**
   * Get multiple keys efficiently
   */
  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) {
      return [];
    }
    return this.redis.mget(...keys);
  }

  /**
   * Set multiple keys efficiently
   */
  async mset(keyValues: Record<string, string | number>): Promise<void> {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(keyValues)) {
      pairs.push(key, String(value));
    }
    if (pairs.length > 0) {
      await this.redis.mset(...pairs);
    }
  }

  /**
   * Delete keys by pattern (use carefully in production)
   */
  async deleteByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');

    return deleted;
  }

  /**
   * Get TTL of a key in seconds
   */
  async getTtl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  /**
   * Increment a counter with optional expiry
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const value = await this.redis.incr(key);
    if (ttlSeconds && value === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    return value;
  }

  /**
   * Increment by a specific amount (for BigInt safety use INCRBY not INCRBYFLOAT)
   */
  async incrby(key: string, amount: number | bigint): Promise<bigint> {
    const result = await this.redis.incrby(key, Number(amount));
    return BigInt(result);
  }

  /**
   * Decrement by a specific amount
   */
  async decrby(key: string, amount: number | bigint): Promise<bigint> {
    const result = await this.redis.decrby(key, Number(amount));
    return BigInt(result);
  }

  /**
   * Set a key with optional TTL
   */
  async set(key: string, value: string | number, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.set(key, String(value), 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, String(value));
    }
  }

  /**
   * Get a key value
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * Delete one or more keys
   */
  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    return this.redis.del(...keys);
  }

  /**
   * Set expiry on a key
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    const result = await this.redis.expire(key, seconds);
    return result === 1;
  }
}