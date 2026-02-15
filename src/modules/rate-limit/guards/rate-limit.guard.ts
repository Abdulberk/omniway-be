import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimitService } from '../rate-limit.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(private readonly rateLimitService: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const authContext = request.authContext;

    if (!authContext) {
      throw new Error('AuthContext not found. RateLimitGuard must be used after AuthGuard.');
    }

    const result = await this.rateLimitService.checkRateLimit(authContext);

    // Set rate limit headers
    this.setRateLimitHeaders(response, result, authContext);

    if (!result.allowed) {
      const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));
      
      this.logger.warn(`Rate limit exceeded for ${authContext.keyPrefix}...`, {
        ownerType: authContext.ownerType,
        ownerId: authContext.ownerId,
        limitedBy: result.limitedBy,
        retryAfter,
      });

      response.header('Retry-After', String(retryAfter));

      throw new HttpException(
        {
          error: {
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            param: result.limitedBy,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private setRateLimitHeaders(
    response: FastifyReply,
    result: Awaited<ReturnType<RateLimitService['checkRateLimit']>>,
    authContext: NonNullable<FastifyRequest['authContext']>,
  ): void {
    // Use the most restrictive limit for display
    const { limitPerMinute, limitPerHour, limitPerDay } = authContext.policy;
    
    // Determine which limit to show (smallest remaining)
    let limit: number;
    let remaining: number;
    let reset: number;

    if (result.minuteRemaining <= result.hourRemaining && 
        result.minuteRemaining <= result.dayRemaining) {
      limit = limitPerMinute;
      remaining = result.minuteRemaining;
      reset = Math.floor(Date.now() / 60000) * 60 + 60;
    } else if (result.hourRemaining <= result.dayRemaining) {
      limit = limitPerHour;
      remaining = result.hourRemaining;
      reset = Math.floor(Date.now() / 3600000) * 3600 + 3600;
    } else {
      limit = limitPerDay;
      remaining = result.dayRemaining;
      reset = Math.floor(Date.now() / 86400000) * 86400 + 86400;
    }

    response.header('X-RateLimit-Limit', String(limit));
    response.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    response.header('X-RateLimit-Reset', String(reset));

    // Also include detailed headers
    response.header('X-RateLimit-Limit-Minute', String(limitPerMinute));
    response.header('X-RateLimit-Remaining-Minute', String(Math.max(0, result.minuteRemaining)));
    response.header('X-RateLimit-Limit-Hour', String(limitPerHour));
    response.header('X-RateLimit-Remaining-Hour', String(Math.max(0, result.hourRemaining)));
    response.header('X-RateLimit-Limit-Day', String(limitPerDay));
    response.header('X-RateLimit-Remaining-Day', String(Math.max(0, result.dayRemaining)));
  }
}