import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RedisService } from '../../../redis/redis.service';
import { UserRequest } from './user.guard';

/**
 * Rate limiting guard for user account endpoints
 * Limits requests per user to prevent abuse and data exfiltration
 *
 * SECURITY: Prevents brute force and enumeration attacks on user endpoints
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);
  private readonly USER_RATE_LIMIT = 200; // requests per hour
  private readonly WINDOW_SECONDS = 3600; // 1 hour

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UserRequest>();

    if (!request.user?.id) {
      throw new Error(
        'UserRateLimitGuard must be used after UserGuard to ensure user is attached',
      );
    }

    const userId = request.user.id;
    const key = `user:ratelimit:${userId}`;
    const now = Math.floor(Date.now() / 1000);
    const windowStart =
      Math.floor(now / this.WINDOW_SECONDS) * this.WINDOW_SECONDS;
    const windowKey = `${key}:${windowStart}`;

    const client = this.redis.getClient();
    const count = await client.incr(windowKey);

    if (count === 1) {
      await client.expire(windowKey, this.WINDOW_SECONDS);
    }

    if (count > this.USER_RATE_LIMIT) {
      this.logger.warn(`User rate limit exceeded for ${userId}`, {
        userId,
        count,
        limit: this.USER_RATE_LIMIT,
      });

      throw new HttpException(
        {
          error: {
            message: 'Rate limit exceeded. Please try again later.',
            type: 'rate_limit_error',
            code: 'user_rate_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
