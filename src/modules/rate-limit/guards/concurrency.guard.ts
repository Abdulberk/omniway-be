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
export class ConcurrencyGuard implements CanActivate {
  private readonly logger = new Logger(ConcurrencyGuard.name);

  constructor(private readonly rateLimitService: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const authContext = request.authContext;

    if (!authContext) {
      throw new Error('AuthContext not found. ConcurrencyGuard must be used after AuthGuard.');
    }

    const requestId = (request.headers['x-request-id'] as string) || request.id;

    const result = await this.rateLimitService.acquireConcurrency(
      authContext,
      requestId,
    );

    // Set concurrency headers
    response.header('X-Concurrency-Limit', String(result.maxCount));
    response.header('X-Concurrency-Current', String(result.currentCount));

    if (!result.allowed) {
      this.logger.warn(`Concurrency limit exceeded for ${authContext.keyPrefix}...`, {
        ownerType: authContext.ownerType,
        ownerId: authContext.ownerId,
        current: result.currentCount,
        max: result.maxCount,
      });

      throw new HttpException(
        {
          error: {
            message: `Too many concurrent requests. Maximum ${result.maxCount} allowed.`,
            type: 'rate_limit_error',
            code: 'concurrency_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Store the request ID for release in the response lifecycle
    // The proxy or controller should call releaseConcurrency after completion
    request['_concurrencyRequestId'] = requestId;

    return true;
  }
}