import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthContext } from '../../modules/auth/interfaces/auth.interfaces';

/**
 * Parameter decorator to extract AuthContext from the request
 * Usage: @AuthContext() authContext: AuthContext
 */
export const GetAuthContext = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    
    if (!request.authContext) {
      throw new Error('AuthContext not found on request. Is AuthGuard applied?');
    }
    
    return request.authContext;
  },
);

/**
 * Get the owner key for Redis operations
 * Format: {ownerType}:{ownerId}
 */
export function getOwnerKey(authContext: AuthContext): string {
  const ownerType = authContext.ownerType === 'USER' ? 'user' : 'org';
  return `${ownerType}:${authContext.ownerId}`;
}