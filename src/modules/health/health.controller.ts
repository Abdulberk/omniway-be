import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

interface HealthCheckResponse {
    status: 'ok' | 'degraded' | 'unhealthy';
    timestamp: string;
    uptime: number;
    version: string;
    checks?: {
        database: { status: string; latency?: number };
        redis: { status: string; latency?: number };
    };
}

@Controller('health')
export class HealthController {
    constructor(private readonly healthService: HealthService) { }

    /**
     * Basic liveness check - responds if the service is running
     * Used by load balancers for basic health checks
     */
    @Get()
    async health(): Promise<{ status: string }> {
        return { status: 'ok' };
    }

    /**
     * Liveness probe - Kubernetes liveness check
     * Returns ok if the process is alive
     */
    @Get('live')
    async live(): Promise<{ status: string }> {
        return { status: 'ok' };
    }

    /**
     * Readiness probe - Kubernetes readiness check
     * Checks if all dependencies are available
     */
    @Get('ready')
    async ready(): Promise<HealthCheckResponse> {
        return this.healthService.checkReadiness();
    }
}