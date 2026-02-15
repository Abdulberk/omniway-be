import {
    Injectable,
    CanActivate,
    ExecutionContext,
    Logger,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from '../auth.service';
import { AuthContext } from '../interfaces/auth.interfaces';

// Extend FastifyRequest to include authContext and other custom properties
declare module 'fastify' {
    interface FastifyRequest {
        authContext?: AuthContext;
        _concurrencyRequestId?: string;
    }
}

@Injectable()
export class AuthGuard implements CanActivate {
    private readonly logger = new Logger(AuthGuard.name);

    constructor(private readonly authService: AuthService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<FastifyRequest>();

        try {
            // Authenticate and get context
            const authContext = await this.authService.authenticate(request);

            // Attach auth context to request for downstream use
            request.authContext = authContext;

            return true;
        } catch (error) {
            // Re-throw authentication errors
            throw error;
        }
    }
}