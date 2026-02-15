import { ApiKeyOwnerType, RequestStatus } from '@prisma/client';

/**
 * Event emitted when a request completes (success or failure)
 * Used for async persistence via BullMQ
 */
export interface RequestCompletedEvent {
  requestId: string;
  
  // Owner context
  ownerType: ApiKeyOwnerType;
  ownerId: string;
  projectId?: string;
  apiKeyId: string;
  
  // Request details
  model: string;
  provider: string;
  endpoint: string;
  
  // Status
  status: RequestStatus;
  statusCode: number;
  errorType?: string;
  errorMessage?: string;
  
  // Timing
  latencyMs: number;
  ttfbMs?: number;
  
  // Token counts (if available from upstream response)
  inputTokens?: number;
  outputTokens?: number;
  
  // Byte counts
  inputBytes: number;
  outputBytes: number;
  
  // Billing
  billingSource?: 'allowance' | 'wallet';
  costCents?: number;
  
  // Pricing reference
  pricingSnapshotId?: string;
  
  // Streaming
  isStreaming: boolean;
  streamChunks?: number;
  
  // Client info
  clientIp?: string;
  userAgent?: string;
  
  // Timestamp
  timestamp: Date;
}

/**
 * Job data for usage processing queue
 */
export interface UsageJobData {
  events: RequestCompletedEvent[];
}

/**
 * Daily aggregation job data
 */
export interface DailyAggregationJobData {
  date: string; // YYYY-MM-DD format
  ownerType: ApiKeyOwnerType;
  ownerId: string;
}

/**
 * Usage daily aggregate
 */
export interface UsageDailyAggregate {
  ownerType: ApiKeyOwnerType;
  ownerId: string;
  date: Date;
  requestCount: number;
  successCount: number;
  errorCount: number;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  totalCostCents: bigint;
  allowanceUsed: number;
}

/**
 * Queue names for usage processing
 */
export const USAGE_QUEUES = {
  EVENTS: 'usage-events',
  AGGREGATION: 'usage-aggregation',
} as const;

/**
 * Job names for usage processing
 */
export const USAGE_JOBS = {
  PROCESS_EVENTS: 'process-events',
  AGGREGATE_DAILY: 'aggregate-daily',
} as const;

/**
 * Convert RequestStatus to boolean for success check
 */
export function isSuccessStatus(status: RequestStatus): boolean {
  return status === 'SUCCESS';
}

/**
 * Calculate request status from HTTP status code and error info
 */
export function determineRequestStatus(
  statusCode: number,
  errorType?: string,
): RequestStatus {
  if (statusCode >= 200 && statusCode < 300) {
    return 'SUCCESS';
  }
  
  if (errorType === 'rate_limited') {
    return 'RATE_LIMITED';
  }
  
  if (errorType === 'billing_blocked') {
    return 'BILLING_BLOCKED';
  }
  
  if (errorType === 'timeout' || errorType === 'TIMEOUT') {
    return 'TIMEOUT';
  }
  
  if (statusCode >= 400 && statusCode < 500) {
    return 'CLIENT_ERROR';
  }
  
  return 'UPSTREAM_ERROR';
}