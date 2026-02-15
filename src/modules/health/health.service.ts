import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

interface HealthCheckResponse {
    status: 'ok' | 'degraded' | 'unhealthy';
    timestamp: string;
    uptime: number;
    version: string;
    checks: {
        database: { status: string; latency?: number };
        redis: { status: string; latency?: number };
    };
}

@Injectable()
export class HealthService {
    private readonly logger = new Logger(HealthService.name);
    private readonly startTime = Date.now();

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) { }

    async checkReadiness(): Promise<HealthCheckResponse> {
        const checks = {
            database: await this.checkDatabase(),
            redis: await this.checkRedis(),
        };

        const allHealthy = Object.values(checks).every(
            (check) => check.status === 'ok',
        );
        const anyUnhealthy = Object.values(checks).some(
            (check) => check.status === 'unhealthy',
        );

        let status: 'ok' | 'degraded' | 'unhealthy';
        if (allHealthy) {
            status = 'ok';
        } else if (anyUnhealthy) {
            status = 'unhealthy';
        } else {
            status = 'degraded';
        }

        return {
            status,
            timestamp: new Date().toISOString(),
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            version: process.env.npm_package_version || '1.0.0',
            checks,
        };
    }

    private async checkDatabase(): Promise<{ status: string; latency?: number }> {
        const start = Date.now();
        try {
            await this.prisma.$queryRaw`SELECT 1`;
            const latency = Date.now() - start;
            return { status: 'ok', latency };
        } catch (error) {
            this.logger.error('Database health check failed', error);
            return { status: 'unhealthy' };
        }
    }

    private async checkRedis(): Promise<{ status: string; latency?: number }> {
        const start = Date.now();
        try {
            const healthy = await this.redis.isHealthy();
            const latency = Date.now() - start;
            return { status: healthy ? 'ok' : 'unhealthy', latency };
        } catch (error) {
            this.logger.error('Redis health check failed', error);
            return { status: 'unhealthy' };
        }
    }
}