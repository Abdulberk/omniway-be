import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PrismaService } from '../../../prisma/prisma.service';

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
 * For MVP, we check a simple Authorization header with user ID
 * In production, replace with proper JWT validation
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Authorization header is required');
    }

    // For MVP: Bearer <user_id> format
    // In production: Replace with JWT validation
    const [bearer, token] = authHeader.split(' ');
    
    if (bearer?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization format');
    }

    // Check if this is a valid user and is super admin
    const user = await this.prisma.user.findUnique({
      where: { id: token },
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