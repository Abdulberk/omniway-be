import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { GatewayController } from './gateway.controller';
import { ModelService } from './model.service';
import { ProxyService } from './proxy.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ModelAccessGuard } from './guards/model-access.guard';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    RateLimitModule,
  ],
  controllers: [GatewayController],
  providers: [
    ModelService,
    ProxyService,
    CircuitBreakerService,
    ModelAccessGuard,
  ],
  exports: [ModelService, ProxyService, CircuitBreakerService],
})
export class GatewayModule {}