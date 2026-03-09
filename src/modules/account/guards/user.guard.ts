import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PrismaService } from '../../../prisma/prisma.service';
import { JwtService, JwtPayload } from '../../auth/jwt.service';

/**
 * Extended request interface for user routes
 */
export interface UserRequest extends FastifyRequest {
  user?: {
    id: string;
    email: string;
    name: string | null;
    isActive: boolean;
  };
}

/**
 * Guard for authenticated user routes
 * Requires JWT authentication with valid signature and claims
 *
 * SECURITY: Validates JWT signature and claims before granting access
 */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UserRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Authorization header is required');
    }

    const [bearer, token] = authHeader.split(' ');

    if (bearer?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization format');
    }

    // Verify JWT token and extract payload
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify(token);
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof UnauthorizedException
          ? err.message
          : 'Invalid or expired token',
      );
    }

    // Fetch user from database to ensure they still exist and are active
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new ForbiddenException('User account is disabled');
    }

    // Attach user to request
    request.user = user;

    return true;
  }
}
