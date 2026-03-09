import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RedisService } from '../../../redis/redis.service';
import { AdminRequest } from './admin.guard';

/**
 * Rate limiting guard for admin endpoints
 * Limits requests per admin user to prevent abuse
 *
 * SECURITY: Prevents brute force attacks on admin endpoints
 */
@Injectable()
export class AdminRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AdminRateLimitGuard.name);
  private readonly ADMIN_RATE_LIMIT = 100; // requests per hour
  private readonly WINDOW_SECONDS = 3600; // 1 hour

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();

    if (!request.adminUser?.id) {
      throw new Error(
        'AdminRateLimitGuard must be used after AdminGuard to ensure adminUser is attached',
      );
    }

    const adminId = request.adminUser.id;
    const key = `admin:ratelimit:${adminId}`;
    const now = Math.floor(Date.now() / 1000);
    const windowStart =
      Math.floor(now / this.WINDOW_SECONDS) * this.WINDOW_SECONDS;
    const windowKey = `${key}:${windowStart}`;

    const client = this.redis.getClient();
    const count = await client.incr(windowKey);

    if (count === 1) {
      await client.expire(windowKey, this.WINDOW_SECONDS);
    }

    if (count > this.ADMIN_RATE_LIMIT) {
      this.logger.warn(`Admin rate limit exceeded for ${adminId}`, {
        adminId,
        count,
        limit: this.ADMIN_RATE_LIMIT,
      });

      throw new HttpException(
        {
          error: {
            message: 'Admin rate limit exceeded. Please try again later.',
            type: 'rate_limit_error',
            code: 'admin_rate_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
