import {
    Injectable,
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthContext } from '../../auth/interfaces/auth.interfaces';
import { ModelService } from '../model.service';

/**
 * Guard to check if the user's plan allows access to the requested model
 * Must run after AuthGuard
 */
@Injectable()
export class ModelAccessGuard implements CanActivate {
    private readonly logger = new Logger(ModelAccessGuard.name);

    constructor(private readonly modelService: ModelService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<FastifyRequest>();
        const authContext = (request as FastifyRequest & { authContext?: AuthContext }).authContext;

        if (!authContext) {
            throw new HttpException(
                {
                    error: {
                        message: 'Authentication required',
                        type: 'authentication_error',
                        code: 'auth_required',
                    },
                },
                HttpStatus.UNAUTHORIZED,
            );
        }

        // Extract model from request body
        const body = request.body as { model?: string } | undefined;
        const modelId = body?.model;

        if (!modelId) {
            throw new HttpException(
                {
                    error: {
                        message: 'model is required',
                        type: 'invalid_request_error',
                        code: 'missing_model',
                        param: 'model',
                    },
                },
                HttpStatus.BAD_REQUEST,
            );
        }

        // Get model info
        const model = await this.modelService.getModel(modelId);

        if (!model) {
            throw new HttpException(
                {
                    error: {
                        message: `Model '${modelId}' not found`,
                        type: 'invalid_request_error',
                        code: 'model_not_found',
                        param: 'model',
                    },
                },
                HttpStatus.NOT_FOUND,
            );
        }

        // Check if model is active
        if (!model.isActive) {
            throw new HttpException(
                {
                    error: {
                        message: `Model '${modelId}' is currently unavailable`,
                        type: 'invalid_request_error',
                        code: 'model_unavailable',
                        param: 'model',
                    },
                },
                HttpStatus.SERVICE_UNAVAILABLE,
            );
        }

        // Warn if model is deprecated
        if (model.isDeprecated) {
            this.logger.warn(`Model '${modelId}' is deprecated`);
        }

        // Check plan's model allowlist
        const { policy } = authContext;

        if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(modelId)) {
            this.logger.warn(
                `Model access denied: ${modelId} not in allowlist for ${authContext.ownerType}:${authContext.ownerId}`,
            );

            throw new HttpException(
                {
                    error: {
                        message: `Model '${modelId}' is not available on your plan`,
                        type: 'invalid_request_error',
                        code: 'model_not_allowed',
                        param: 'model',
                    },
                },
                HttpStatus.FORBIDDEN,
            );
        }

        // Attach model info to request for downstream use
        (request as FastifyRequest & { modelInfo?: typeof model }).modelInfo = model;

        return true;
    }
}