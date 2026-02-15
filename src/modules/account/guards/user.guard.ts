import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PrismaService } from '../../../prisma/prisma.service';

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
 * Requires JWT/session authentication
 * 
 * For MVP, we check a simple Authorization header with user ID
 * In production, replace with proper JWT validation
 */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UserRequest>();
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

    // Check if this is a valid user
    const user = await this.prisma.user.findUnique({
      where: { id: token },
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