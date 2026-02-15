import {
    Injectable,
    OnModuleInit,
    OnModuleDestroy,
    Logger,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

@Injectable()
export class PrismaService
    extends PrismaClient
    implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);

    constructor() {
        super({
            log: [
                { emit: 'event', level: 'query' },
                { emit: 'event', level: 'error' },
                { emit: 'event', level: 'warn' },
            ],
        });

        // Log slow queries in development
        if (process.env.NODE_ENV === 'development') {
            (this as any).$on('query', (e: Prisma.QueryEvent) => {
                if (e.duration > 100) {
                    this.logger.warn(
                        `Slow query (${e.duration}ms): ${e.query.substring(0, 200)}`,
                    );
                }
            });
        }
    }

    async onModuleInit() {
        this.logger.log('Connecting to database...');
        await this.$connect();
        this.logger.log('Database connection established');
    }

    async onModuleDestroy() {
        this.logger.log('Disconnecting from database...');
        await this.$disconnect();
        this.logger.log('Database connection closed');
    }

    /**
     * Wrapper for BigInt values from Redis to ensure safe handling
     * Use this when reading BigInt values that came from Redis INCRBY
     */
    safeBigInt(value: string | number | bigint): bigint {
        if (typeof value === 'bigint') {
            return value;
        }
        // Always parse through string to avoid floating point issues
        return BigInt(String(value));
    }

    /**
     * Check if a BigInt value is within safe JavaScript integer range
     */
    isSafeInteger(value: bigint): boolean {
        return value <= BigInt(Number.MAX_SAFE_INTEGER);
    }

    /**
     * Clean shutdown helper for graceful termination
     */
    async cleanShutdown(): Promise<void> {
        try {
            await this.$disconnect();
        } catch (error) {
            this.logger.error('Error during database shutdown', error);
        }
    }
}