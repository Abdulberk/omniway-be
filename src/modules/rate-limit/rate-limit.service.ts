import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { AuthContext } from '../auth/interfaces/auth.interfaces';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface RateLimitResult {
  allowed: boolean;
  minuteRemaining: number;
  hourRemaining: number;
  dayRemaining: number;
  resetAt: number;
  limitedBy?: 'minute' | 'hour' | 'day' | 'none';
}

export interface ConcurrencyResult {
  allowed: boolean;
  currentCount: number;
  maxCount: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private rateLimitScript: string;
  private concurrencyScript: string;

  constructor(private readonly redis: RedisService) {
    // Load Lua scripts
    this.rateLimitScript = this.loadScript('rate-limit.lua');
    this.concurrencyScript = this.loadScript('concurrency.lua');
  }

  private loadScript(filename: string): string {
    try {
      return readFileSync(
        join(__dirname, 'lua', filename),
        'utf-8',
      );
    } catch (error) {
      this.logger.error(`Failed to load Lua script: ${filename}`, error);
      throw error;
    }
  }

  /**
   * Check and apply rate limits for a request
   */
  async checkRateLimit(authContext: AuthContext): Promise<RateLimitResult> {
    const ownerKey = this.getOwnerKey(authContext);
    const now = Math.floor(Date.now() / 1000);

    // Generate time-window keys
    const minuteKey = this.getRateLimitKey(ownerKey, 'minute', now);
    const hourKey = this.getRateLimitKey(ownerKey, 'hour', now);
    const dayKey = this.getRateLimitKey(ownerKey, 'day', now);

    const { limitPerMinute, limitPerHour, limitPerDay } = authContext.policy;

    try {
      const result = await this.redis.evalLua<(number | string)[]>(
        this.rateLimitScript,
        [minuteKey, hourKey, dayKey],
        [limitPerMinute, limitPerHour, limitPerDay, now],
      );

      const [allowed, minuteRemaining, hourRemaining, dayRemaining, resetAt, limitedBy] = result;

      return {
        allowed: allowed === 1,
        minuteRemaining: Number(minuteRemaining),
        hourRemaining: Number(hourRemaining),
        dayRemaining: Number(dayRemaining),
        resetAt: Number(resetAt),
        limitedBy: limitedBy as RateLimitResult['limitedBy'],
      };
    } catch (error) {
      this.logger.error('Rate limit check failed', { error, ownerKey });
      // Fail open - allow request if Redis fails (with logging)
      return {
        allowed: true,
        minuteRemaining: limitPerMinute,
        hourRemaining: limitPerHour,
        dayRemaining: limitPerDay,
        resetAt: now + 60,
        limitedBy: 'none',
      };
    }
  }

  /**
   * Acquire a concurrency slot
   */
  async acquireConcurrency(
    authContext: AuthContext,
    requestId: string,
  ): Promise<ConcurrencyResult> {
    const ownerKey = this.getOwnerKey(authContext);
    const concurrencyKey = `concurrency:${ownerKey}`;
    const maxConcurrent = authContext.policy.maxConcurrent;
    const ttl = 300; // 5 minute safety TTL

    try {
      const result = await this.redis.evalLua<number[]>(
        this.concurrencyScript,
        [concurrencyKey],
        [maxConcurrent, requestId, ttl, 'acquire'],
      );

      const [allowed, currentCount, maxCount] = result;

      return {
        allowed: allowed === 1,
        currentCount: Number(currentCount),
        maxCount: Number(maxCount),
      };
    } catch (error) {
      this.logger.error('Concurrency acquire failed', { error, ownerKey });
      // Fail open
      return {
        allowed: true,
        currentCount: 0,
        maxCount: maxConcurrent,
      };
    }
  }

  /**
   * Release a concurrency slot
   */
  async releaseConcurrency(
    authContext: AuthContext,
    requestId: string,
  ): Promise<void> {
    const ownerKey = this.getOwnerKey(authContext);
    const concurrencyKey = `concurrency:${ownerKey}`;
    const maxConcurrent = authContext.policy.maxConcurrent;

    try {
      await this.redis.evalLua(
        this.concurrencyScript,
        [concurrencyKey],
        [maxConcurrent, requestId, 300, 'release'],
      );
    } catch (error) {
      this.logger.error('Concurrency release failed', { error, ownerKey, requestId });
      // Non-critical - slot will auto-expire
    }
  }

  /**
   * Get owner key for Redis operations
   * Format: {ownerType}:{ownerId}
   */
  private getOwnerKey(authContext: AuthContext): string {
    const ownerType = authContext.ownerType === 'USER' ? 'user' : 'org';
    return `${ownerType}:${authContext.ownerId}`;
  }

  /**
   * Generate rate limit key with time window
   */
  private getRateLimitKey(
    ownerKey: string,
    window: 'minute' | 'hour' | 'day',
    timestamp: number,
  ): string {
    let windowKey: string;

    switch (window) {
      case 'minute':
        windowKey = Math.floor(timestamp / 60).toString();
        break;
      case 'hour':
        windowKey = Math.floor(timestamp / 3600).toString();
        break;
      case 'day':
        windowKey = Math.floor(timestamp / 86400).toString();
        break;
    }

    return `rl:${ownerKey}:${window}:${windowKey}`;
  }

  /**
   * Get current usage counts (for dashboard/API)
   */
  async getCurrentUsage(authContext: AuthContext): Promise<{
    minute: number;
    hour: number;
    day: number;
    concurrent: number;
  }> {
    const ownerKey = this.getOwnerKey(authContext);
    const now = Math.floor(Date.now() / 1000);

    const minuteKey = this.getRateLimitKey(ownerKey, 'minute', now);
    const hourKey = this.getRateLimitKey(ownerKey, 'hour', now);
    const dayKey = this.getRateLimitKey(ownerKey, 'day', now);
    const concurrencyKey = `concurrency:${ownerKey}`;

    try {
      const [minute, hour, day, concurrent] = await this.redis.mget([
        minuteKey,
        hourKey,
        dayKey,
        concurrencyKey,
      ]);

      return {
        minute: minute ? parseInt(minute, 10) : 0,
        hour: hour ? parseInt(hour, 10) : 0,
        day: day ? parseInt(day, 10) : 0,
        concurrent: concurrent ? parseInt(concurrent, 10) : 0,
      };
    } catch (error) {
      this.logger.error('Failed to get current usage', { error, ownerKey });
      return { minute: 0, hour: 0, day: 0, concurrent: 0 };
    }
  }
}