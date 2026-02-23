import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PrismaService } from '../../../prisma/prisma.service';
import { JwtService, JwtPayload } from '../../auth/jwt.service';

/**
 * Extended request interface for admin routes
 */
export interface AdminRequest extends FastifyRequest {
  adminUser?: {
    id: string;
    email: string;
    isSuperAdmin: boolean;
  };
}

/**
 * Guard for admin-only routes
 * Requires JWT authentication and superadmin status
 *
 * SECURITY: Validates JWT signature and claims before checking admin status
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) { }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
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

    // Check if user exists and is super admin
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        isActive: true,
        isSuperAdmin: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new ForbiddenException('User account is disabled');
    }

    if (!user.isSuperAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    // Attach admin user to request
    request.adminUser = {
      id: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    };

    return true;
  }
}
