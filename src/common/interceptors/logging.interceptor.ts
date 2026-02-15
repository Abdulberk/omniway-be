import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { FastifyRequest, FastifyReply } from 'fastify';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private readonly logger = new Logger('HTTP');

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const ctx = context.switchToHttp();
        const request = ctx.getRequest<FastifyRequest>();
        const response = ctx.getResponse<FastifyReply>();

        const { method, url } = request;
        const requestId = (request.headers['x-request-id'] as string) || request.id;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip;

        const startTime = Date.now();

        return next.handle().pipe(
            tap({
                next: () => {
                    const duration = Date.now() - startTime;
                    const statusCode = response.statusCode;

                    this.logger.log(
                        `${method} ${url} ${statusCode} ${duration}ms`,
                        {
                            requestId,
                            method,
                            url,
                            statusCode,
                            duration,
                            ip,
                            userAgent: userAgent.substring(0, 100),
                        },
                    );
                },
                error: (error: Error) => {
                    const duration = Date.now() - startTime;

                    this.logger.error(
                        `${method} ${url} ERROR ${duration}ms - ${error.message}`,
                        {
                            requestId,
                            method,
                            url,
                            duration,
                            ip,
                            error: error.name,
                        },
                    );
                },
            }),
        );
    }
}