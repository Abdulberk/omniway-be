import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
    ConfigModule,
    PrismaModule,
    
    // Register BullMQ queues
    BullModule.registerQueueAsync({
      name: USAGE_QUEUES.EVENTS,
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
          db: configService.get<number>('REDIS_DB', 0),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      }),
      inject: [ConfigService],
    }),
    
    BullModule.registerQueueAsync({
      name: USAGE_QUEUES.AGGREGATION,
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
          db: configService.get<number>('REDIS_DB', 0),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    UsageService,
    UsageEventsProcessor,
  ],
  exports: [UsageService],
})
export class UsageModule {}