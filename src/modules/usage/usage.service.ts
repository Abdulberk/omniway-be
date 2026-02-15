import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
 * Events are batched internally for efficiency.
 */
@Injectable()
export class UsageService implements OnModuleInit {
  private readonly logger = new Logger(UsageService.name);
  
  // Event buffer for batching
  private eventBuffer: RequestCompletedEvent[] = [];
  private readonly BATCH_SIZE = 100;
  private readonly FLUSH_INTERVAL_MS = 5000;
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(
    @InjectQueue(USAGE_QUEUES.EVENTS) private readonly eventsQueue: Queue,
  ) {}

  onModuleInit() {
    // Start periodic flush interval
    this.flushInterval = setInterval(() => {
      this.flushBuffer().catch(err => {
        this.logger.error('Failed to flush event buffer:', err);
      });
    }, this.FLUSH_INTERVAL_MS);

    this.logger.log('UsageService initialized with batching enabled');
  }

  /**
   * Emit a request completed event for async processing
   */
  async emitRequestCompleted(event: RequestCompletedEvent): Promise<void> {
    this.eventBuffer.push(event);
    
    // Flush immediately if batch size reached
    if (this.eventBuffer.length >= this.BATCH_SIZE) {
      await this.flushBuffer();
    }
  }

  /**
   * Flush buffered events to the queue
   */
  private async flushBuffer(): Promise<void> {
    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    try {
      await this.eventsQueue.add(
        USAGE_JOBS.PROCESS_EVENTS,
        { events },
        {
          // Job options for reliability
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: {
            count: 1000, // Keep last 1000 completed jobs
            age: 3600,   // Or jobs older than 1 hour
          },
          removeOnFail: {
            count: 5000, // Keep last 5000 failed jobs for debugging
          },
        },
      );
      
      this.logger.debug(`Flushed ${events.length} events to queue`);
    } catch (error) {
      // Put events back in buffer on failure
      this.eventBuffer.unshift(...events);
      this.logger.error(`Failed to queue ${events.length} events:`, error);
      throw error;
    }
  }

  /**
   * Force flush all buffered events (called on shutdown)
   */
  async forceFlush(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    await this.flushBuffer();
    this.logger.log('UsageService force flushed');
  }

  /**
   * Get current buffer size (for monitoring)
   */
  getBufferSize(): number {
    return this.eventBuffer.length;
  }
}