import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RequestCompletedEvent,
  UsageJobData,
  USAGE_QUEUES,
  isSuccessStatus,
} from './interfaces/usage.interfaces';

/**
 * Usage Events Processor
 * 
 * Processes batched request events and persists them to the database.
 * Also triggers daily aggregation updates.
 */
@Processor(USAGE_QUEUES.EVENTS, {
  concurrency: 5, // Process up to 5 batches concurrently
})
export class UsageEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(UsageEventsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<UsageJobData>): Promise<void> {
    const { events } = job.data;
    
    if (!events || events.length === 0) {
      this.logger.debug('Empty events batch, skipping');
      return;
    }

    this.logger.debug(`Processing batch of ${events.length} events`);

    try {
      // 1. Batch insert request events
      await this.insertRequestEvents(events);
      
      // 2. Update daily aggregates
      await this.updateDailyAggregates(events);
      
      this.logger.debug(`Successfully processed ${events.length} events`);
    } catch (error) {
      this.logger.error(
        `Failed to process events batch: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error; // Re-throw to trigger retry
    }
  }

  /**
   * Batch insert request events to database
   */
  private async insertRequestEvents(events: RequestCompletedEvent[]): Promise<void> {
    const data = events.map(event => ({
      requestId: event.requestId,
      ownerType: event.ownerType,
      ownerId: event.ownerId,
      projectId: event.projectId,
      apiKeyId: event.apiKeyId,
      model: event.model,
      provider: event.provider,
      endpoint: event.endpoint,
      status: event.status,
      statusCode: event.statusCode,
      errorType: event.errorType,
      errorMessage: event.errorMessage,
      latencyMs: event.latencyMs,
      ttfbMs: event.ttfbMs,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      inputBytes: event.inputBytes,
      outputBytes: event.outputBytes,
      billingSource: event.billingSource,
      costCents: event.costCents,
      pricingSnapshotId: event.pricingSnapshotId,
      isStreaming: event.isStreaming,
      streamChunks: event.streamChunks,
      clientIp: event.clientIp,
      userAgent: event.userAgent,
      createdAt: event.timestamp,
    }));

    // Use createMany for batch insert (skipDuplicates handles idempotency)
    await this.prisma.requestEvent.createMany({
      data,
      skipDuplicates: true, // requestId is unique, skip if already exists
    });
  }

  /**
   * Update daily usage aggregates
   * Groups events by owner and date, then upserts aggregates
   */
  private async updateDailyAggregates(events: RequestCompletedEvent[]): Promise<void> {
    // Group events by owner+date
    const aggregateMap = new Map<string, {
      ownerType: RequestCompletedEvent['ownerType'];
      ownerId: string;
      date: Date;
      requestCount: number;
      successCount: number;
      errorCount: number;
      totalInputTokens: bigint;
      totalOutputTokens: bigint;
      totalCostCents: bigint;
      allowanceUsed: number;
    }>();

    for (const event of events) {
      // Get UTC date (start of day)
      const eventDate = new Date(event.timestamp);
      const dateKey = eventDate.toISOString().split('T')[0];
      const mapKey = `${event.ownerType}:${event.ownerId}:${dateKey}`;

      let aggregate = aggregateMap.get(mapKey);
      if (!aggregate) {
        aggregate = {
          ownerType: event.ownerType,
          ownerId: event.ownerId,
          date: new Date(dateKey),
          requestCount: 0,
          successCount: 0,
          errorCount: 0,
          totalInputTokens: BigInt(0),
          totalOutputTokens: BigInt(0),
          totalCostCents: BigInt(0),
          allowanceUsed: 0,
        };
        aggregateMap.set(mapKey, aggregate);
      }

      aggregate.requestCount++;
      
      if (isSuccessStatus(event.status)) {
        aggregate.successCount++;
      } else {
        aggregate.errorCount++;
      }

      if (event.inputTokens) {
        aggregate.totalInputTokens += BigInt(event.inputTokens);
      }
      if (event.outputTokens) {
        aggregate.totalOutputTokens += BigInt(event.outputTokens);
      }
      if (event.costCents) {
        aggregate.totalCostCents += BigInt(event.costCents);
      }
      if (event.billingSource === 'allowance') {
        aggregate.allowanceUsed++;
      }
    }

    // Upsert each aggregate
    for (const aggregate of aggregateMap.values()) {
      await this.prisma.usageDaily.upsert({
        where: {
          ownerType_ownerId_date: {
            ownerType: aggregate.ownerType,
            ownerId: aggregate.ownerId,
            date: aggregate.date,
          },
        },
        create: {
          ownerType: aggregate.ownerType,
          ownerId: aggregate.ownerId,
          date: aggregate.date,
          requestCount: aggregate.requestCount,
          successCount: aggregate.successCount,
          errorCount: aggregate.errorCount,
          totalInputTokens: aggregate.totalInputTokens,
          totalOutputTokens: aggregate.totalOutputTokens,
          totalCostCents: aggregate.totalCostCents,
          allowanceUsed: aggregate.allowanceUsed,
        },
        update: {
          requestCount: { increment: aggregate.requestCount },
          successCount: { increment: aggregate.successCount },
          errorCount: { increment: aggregate.errorCount },
          totalInputTokens: { increment: aggregate.totalInputTokens },
          totalOutputTokens: { increment: aggregate.totalOutputTokens },
          totalCostCents: { increment: aggregate.totalCostCents },
          allowanceUsed: { increment: aggregate.allowanceUsed },
        },
      });
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<UsageJobData>) {
    this.logger.debug(`Job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<UsageJobData>, error: Error) {
    this.logger.error(
      `Job ${job.id} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(`Job ${jobId} stalled`);
  }
}