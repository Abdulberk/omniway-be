import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { ConcurrencyGuard } from './guards/concurrency.guard';

@Module({
    providers: [RateLimitService, RateLimitGuard, ConcurrencyGuard],
    exports: [RateLimitService, RateLimitGuard, ConcurrencyGuard],
})
export class RateLimitModule { }