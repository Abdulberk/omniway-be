import { ApiKeyOwnerType } from '@prisma/client';
import {
  AuthContext,
  ResolvedPolicy,
  ApiKeyValidation,
} from '../../modules/auth/interfaces/auth.interfaces';

/**
 * Default test policy (Pro plan)
 */
export const testPolicy: ResolvedPolicy = {
  planId: 'plan_pro',
  planSlug: 'pro',
  limitPerMinute: 60,
  limitPerHour: 600,
  limitPerDay: 5000,
  dailyAllowance: 1000,
  maxConcurrent: 10,
  maxInputTokens: 128000,
  maxOutputTokens: 16000,
  maxBodyBytes: 10485760,
  allowedModels: [],
  hasWalletAccess: true,
  hasStreaming: true,
  hasPriorityQueue: false,
  subscriptionStatus: 'ACTIVE',
  subscriptionEndsAt: new Date('2030-01-01'),
  walletEnabled: true,
  walletLocked: false,
};

/**
 * Free tier policy (restricted)
 */
export const freeTierPolicy: ResolvedPolicy = {
  planId: 'plan_free_default',
  planSlug: 'free',
  limitPerMinute: 10,
  limitPerHour: 50,
  limitPerDay: 100,
  dailyAllowance: 100,
  maxConcurrent: 2,
  maxInputTokens: 4000,
  maxOutputTokens: 2000,
  maxBodyBytes: 524288,
  allowedModels: ['gpt-3.5-turbo', 'claude-3-haiku'],
  hasWalletAccess: false,
  hasStreaming: true,
  hasPriorityQueue: false,
  subscriptionStatus: 'none',
  subscriptionEndsAt: null,
  walletEnabled: false,
  walletLocked: false,
};

/**
 * Test API key data (as returned from DB)
 */
export const testApiKeyData: NonNullable<ApiKeyValidation['apiKey']> = {
  id: 'key_test_123',
  keyPrefix: 'omni_test1234',
  ownerType: ApiKeyOwnerType.USER,
  userId: 'user_test_123',
  projectId: null,
  scopes: ['chat:write', 'embeddings:write'],
  allowedModels: [],
  allowedIps: [],
  isActive: true,
  expiresAt: null,
};

/**
 * Test API key data for project-level key
 */
export const testProjectApiKeyData: NonNullable<ApiKeyValidation['apiKey']> = {
  id: 'key_test_456',
  keyPrefix: 'omni_proj5678',
  ownerType: ApiKeyOwnerType.PROJECT,
  userId: null,
  projectId: 'project_test_123',
  scopes: ['chat:write'],
  allowedModels: ['gpt-4', 'claude-3-sonnet'],
  allowedIps: ['10.0.0.1', '10.0.0.2'],
  isActive: true,
  expiresAt: null,
};

/**
 * Test auth context for a user
 */
export const testUserAuthContext: AuthContext = {
  apiKeyId: 'key_test_123',
  keyPrefix: 'omni_test1234',
  ownerType: ApiKeyOwnerType.USER,
  ownerId: 'user_test_123',
  userId: 'user_test_123',
  scopes: ['chat:write', 'embeddings:write'],
  allowedModels: [],
  allowedIps: [],
  policy: testPolicy,
};

/**
 * Test auth context for a project
 */
export const testProjectAuthContext: AuthContext = {
  apiKeyId: 'key_test_456',
  keyPrefix: 'omni_proj5678',
  ownerType: ApiKeyOwnerType.PROJECT,
  ownerId: 'org_test_123',
  organizationId: 'org_test_123',
  projectId: 'project_test_123',
  scopes: ['chat:write'],
  allowedModels: ['gpt-4', 'claude-3-sonnet'],
  allowedIps: ['10.0.0.1', '10.0.0.2'],
  policy: testPolicy,
};

/**
 * Valid API key (omni_ prefix + 32 chars base64url)
 */
export const VALID_API_KEY = 'omni_dGVzdGtleS0xMjM0NTY3ODkw';
export const VALID_API_KEY_HASH =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/**
 * Test subscription data
 */
export const testSubscription = {
  id: 'sub_test_123',
  userId: 'user_test_123',
  organizationId: null,
  planId: 'plan_pro',
  status: 'ACTIVE' as const,
  stripeSubscriptionId: 'sub_stripe_123',
  currentPeriodStart: new Date('2024-01-01'),
  currentPeriodEnd: new Date('2030-01-01'),
  plan: {
    id: 'plan_pro',
    slug: 'pro',
    name: 'Pro Plan',
    limitPerMinute: 60,
    limitPerHour: 600,
    limitPerDay: 5000,
    dailyAllowance: 1000,
    maxConcurrent: 10,
    maxInputTokens: 128000,
    maxOutputTokens: 16000,
    maxBodyBytes: 10485760,
    allowedModels: [],
    hasWalletAccess: true,
    hasStreaming: true,
    hasPriorityQueue: false,
  },
};
