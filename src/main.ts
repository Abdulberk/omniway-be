import { NestFactory } from '@nestjs/core';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
    const logger = new Logger('Bootstrap');

    // Create Fastify adapter with options
    const fastifyAdapter = new FastifyAdapter({
        logger: {
            level: process.env.LOG_LEVEL || 'info',
            transport:
                process.env.NODE_ENV !== 'production'
                    ? {
                        target: 'pino-pretty',
                        options: {
                            colorize: true,
                            translateTime: 'HH:MM:ss Z',
                            ignore: 'pid,hostname',
                        },
                    }
                    : undefined,
        },
        trustProxy: true,
        bodyLimit: 10 * 1024 * 1024, // 10MB max body size
        requestIdHeader: 'x-request-id',
        genReqId: () => crypto.randomUUID(),
    });

    // Create NestJS application with rawBody enabled for Stripe webhooks
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        fastifyAdapter,
        {
            bufferLogs: true,
            rawBody: true,
        },
    );

    // Configure rawBody for specific routes (Stripe webhooks)
    const fastifyInstance = app.getHttpAdapter().getInstance();
    fastifyInstance.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (req: any, body: Buffer, done: (err: Error | null, body?: any) => void) => {
            // Store raw body for webhook signature verification
            req.rawBody = body;
            try {
                const json = body.length > 0 ? JSON.parse(body.toString()) : {};
                done(null, json);
            } catch (err) {
                done(err as Error);
            }
        },
    );

    // Get config service
    const configService = app.get(ConfigService);

    // Global validation pipe
    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: {
                enableImplicitConversion: true,
            },
        }),
    );

    // CORS configuration
    app.enableCors({
        origin: configService.get<string>('CORS_ORIGINS', '*').split(','),
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Request-ID',
            'X-Idempotency-Key',
        ],
        exposedHeaders: [
            'X-Request-ID',
            'X-RateLimit-Limit',
            'X-RateLimit-Remaining',
            'X-RateLimit-Reset',
            'Retry-After',
        ],
        credentials: true,
        maxAge: 86400,
    });

    // Global prefix for API versioning
    app.setGlobalPrefix('v1', {
        exclude: ['health', 'health/ready', 'health/live', 'webhooks/stripe'],
    });

    // Graceful shutdown
    app.enableShutdownHooks();

    // Get port from config
    const port = configService.get<number>('PORT', 3000);
    const host = configService.get<string>('HOST', '0.0.0.0');

    // Start server
    await app.listen(port, host);

    logger.log(`🚀 Omniway API Gateway running on http://${host}:${port}`);
    logger.log(`📊 Health check available at http://${host}:${port}/health`);
    logger.log(
        `🔧 Environment: ${configService.get<string>('NODE_ENV', 'development')}`,
    );
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

bootstrap();
