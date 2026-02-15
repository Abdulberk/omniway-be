import { ApiKeyOwnerType } from '@prisma/client';

/**
 * Billing result from atomic Lua script
 */
export interface BillingResult {
  /**
   * 0 = insufficient funds
   * 1 = success (new charge)
   * 2 = idempotent hit (already processed)
   */
  code: 0 | 1 | 2;
  
  /**
   * Which billing source was used
   */
  source: 'allowance' | 'wallet' | 'insufficient_wallet';
  
  /**
   * Amount charged in cents (0 for allowance)
   */
  chargedCents: number;
  
  /**
   * Remaining daily allowance (after deduction if applicable)
   */
  allowanceRemaining: number;
  
  /**
   * Current wallet balance as string (BigInt safe)
   */
  walletBalanceCents: string;
}

/**
 * Context for billing operations
 */
export interface BillingContext {
  ownerType: 'user' | 'org';
  ownerId: string;
  requestId: string;
  model: string;
  isStreaming: boolean;
}

/**
 * Model pricing info
 */
export interface ModelPricing {
  modelId: string;
  priceCents: number;
  inputPricePer1M: number;
  outputPricePer1M: number;
}

/**
 * Wallet charge parameters
 */
export interface WalletChargeParams {
  ownerType: 'user' | 'org';
  ownerId: string;
  amountCents: number;
  requestId: string;
  model: string;
  newBalanceFromLua: bigint;
}

/**
 * Wallet top-up parameters
 */
export interface WalletTopupParams {
  ownerType: 'user' | 'org';
  ownerId: string;
  amountCents: number;
  referenceType: string;
  referenceId: string;
  description?: string;
}

/**
 * Wallet refund parameters
 */
export interface WalletRefundParams {
  ownerType: 'user' | 'org';
  ownerId: string;
  amountCents: number;
  requestId: string;
  reason: string;
}

/**
 * Daily usage info
 */
export interface DailyUsageInfo {
  allowanceUsed: number;
  allowanceRemaining: number;
  walletBalanceCents: string;
  walletLocked: boolean;
}

/**
 * Redis keys for billing operations
 */
export const BILLING_KEYS = {
  // Daily allowance usage counter (resets at UTC midnight)
  allowanceUsed: (ownerType: string, ownerId: string, dateStr: string) =>
    `allow:used:${ownerType}:${ownerId}:${dateStr}`,
  
  // Wallet balance cache (hot path, no TTL)
  walletBalance: (ownerType: string, ownerId: string) =>
    `wallet:${ownerType}:${ownerId}:balance_cents`,
  
  // Wallet lock flag (for disputes)
  walletLocked: (ownerType: string, ownerId: string) =>
    `wallet:${ownerType}:${ownerId}:locked`,
  
  // Billing idempotency (24h TTL)
  billingIdempotency: (ownerType: string, ownerId: string, requestId: string) =>
    `idem:billing:${ownerType}:${ownerId}:${requestId}`,
  
  // Response cache for non-streaming idempotency (24h TTL)
  responseCache: (ownerType: string, ownerId: string, requestId: string) =>
    `idem:response:${ownerType}:${ownerId}:${requestId}`,
  
  // Daily refund counter (resets at UTC midnight)
  refundCount: (ownerType: string, ownerId: string, dateStr: string) =>
    `refund:${ownerType}:${ownerId}:${dateStr}`,
  
  // Refund idempotency (24h TTL)
  refundIdempotency: (ownerType: string, ownerId: string, requestId: string) =>
    `idem:refund:${ownerType}:${ownerId}:${requestId}`,
} as const;

/**
 * Constants for billing
 */
export const BILLING_CONSTANTS = {
  // Idempotency cache TTL (24 hours)
  IDEMPOTENCY_TTL_SECONDS: 86400,
  
  // Max wallet balance (2^53 - 1 for JavaScript safety)
  MAX_WALLET_BALANCE_CENTS: BigInt('9007199254740991'),
  
  // Daily refund cap per owner
  DAILY_REFUND_CAP: 10,
  
  // Max cacheable response size (2MB)
  MAX_RESPONSE_CACHE_SIZE: 2 * 1024 * 1024,
} as const;

/**
 * Convert ApiKeyOwnerType enum to billing owner type string
 */
export function toBillingOwnerType(ownerType: ApiKeyOwnerType): 'user' | 'org' {
  return ownerType === 'USER' ? 'user' : 'org';
}

/**
 * Get UTC date string (YYYYMMDD) for today
 */
export function getUtcDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Calculate seconds until UTC midnight (for TTL)
 */
export function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
}