import { ApiKeyOwnerType } from '@prisma/client';

/**
 * Authenticated context attached to each request
 * Contains all information needed for authorization and billing
 */
export interface AuthContext {
  // API Key info
  apiKeyId: string;
  keyPrefix: string;
  
  // Owner info (user or org)
  ownerType: ApiKeyOwnerType;
  ownerId: string;
  
  // For PROJECT keys, includes the org context
  organizationId?: string;
  projectId?: string;
  
  // User info (for USER keys or org member context)
  userId?: string;
  
  // Key permissions
  scopes: string[];
  allowedModels: string[];
  allowedIps: string[];
  
  // Resolved policy (from plan)
  policy: ResolvedPolicy;
}

/**
 * Policy resolved from subscription/plan
 * Cached in Redis for fast access
 */
export interface ResolvedPolicy {
  // Plan identification
  planId: string;
  planSlug: string;
  
  // Rate limits (requests)
  limitPerMinute: number;
  limitPerHour: number;
  limitPerDay: number;
  
  // Daily allowance (requests granted per day)
  dailyAllowance: number;
  
  // Concurrency
  maxConcurrent: number;
  
  // Request constraints
  maxInputTokens: number;
  maxOutputTokens: number;
  maxBodyBytes: number;
  
  // Model access
  allowedModels: string[];
  
  // Feature flags
  hasWalletAccess: boolean;
  hasStreaming: boolean;
  hasPriorityQueue: boolean;
  
  // Subscription status
  subscriptionStatus: string;
  subscriptionEndsAt: Date | null;
  
  // Wallet info (if applicable)
  walletEnabled: boolean;
  walletLocked: boolean;
}

/**
 * API Key validation result
 */
export interface ApiKeyValidation {
  isValid: boolean;
  reason?: string;
  apiKey?: {
    id: string;
    keyPrefix: string;
    ownerType: ApiKeyOwnerType;
    userId: string | null;
    projectId: string | null;
    scopes: string[];
    allowedModels: string[];
    allowedIps: string[];
    isActive: boolean;
    expiresAt: Date | null;
  };
}

/**
 * Redis cache keys for auth
 */
export const AUTH_CACHE_KEYS = {
  // API key lookup by hash
  apiKeyByHash: (hash: string) => `auth:key:${hash}`,
  
  // Policy by owner
  policy: (ownerType: string, ownerId: string) => `policy:${ownerType}:${ownerId}`,
  
  // Key invalidation
  invalidatedKey: (keyId: string) => `auth:invalidated:${keyId}`,
} as const;

/**
 * Cache TTLs in seconds
 */
export const AUTH_CACHE_TTL = {
  apiKey: 300, // 5 minutes
  policy: 300, // 5 minutes
  invalidation: 86400, // 24 hours
} as const;