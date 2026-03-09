import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  RequestCompletedEvent,
  USAGE_QUEUES,
  USAGE_JOBS,
} from './interfaces/usage.interfaces';

/**
 * Usage Service
 *
 * Handles emitting request completed events to BullMQ for async processing.
 * Each event is enqueued immediately to avoid in-memory data loss on crashes.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectQueue(USAGE_QUEUES.EVENTS) private readonly eventsQueue: Queue,
  ) {}

  /**
   * Emit a request completed event for async processing
   */
  async emitRequestCompleted(event: RequestCompletedEvent): Promise<void> {
    await this.eventsQueue.add(
      USAGE_JOBS.PROCESS_EVENTS,
      { events: [event] },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          count: 1000,
          age: 3600,
        },
        removeOnFail: {
          count: 5000,
        },
      },
    );
  }

  /**
   * Immediate-queue mode has no in-memory buffer to flush.
   */
  async forceFlush(): Promise<void> {
    this.logger.debug('UsageService forceFlush called with empty local buffer');
  }

  /**
   * Get current buffer size (for monitoring)
   */
  getBufferSize(): number {
    return 0;
  }
}
