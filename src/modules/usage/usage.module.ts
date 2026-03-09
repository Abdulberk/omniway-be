import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../prisma/prisma.module';
import { UsageService } from './usage.service';
import { UsageEventsProcessor } from './usage-events.processor';
import { USAGE_QUEUES } from './interfaces/usage.interfaces';

/**
 * Usage Module
 *
 * Provides async usage event processing via BullMQ.
 * - UsageService: Emits events to the queue with batching
 * - UsageEventsProcessor: Processes events and persists to DB
 *
 * Global module - available throughout the application.
 */
@Global()
@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: USAGE_QUEUES.EVENTS }),
    BullModule.registerQueue({ name: USAGE_QUEUES.AGGREGATION }),
  ],
  providers: [UsageService, UsageEventsProcessor],
  exports: [UsageService],
})
export class UsageModule {}
