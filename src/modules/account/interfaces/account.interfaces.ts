import { SubscriptionStatus, WalletTxType, MembershipRole } from '@prisma/client';

/**
 * Account interfaces for self-service APIs
 */

// User profile
export interface UserProfileResponse {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  subscription: {
    id: string;
    planId: string;
    planName: string;
    planSlug: string;
    status: SubscriptionStatus;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    dailyAllowance: number;
    limits: {
      perMinute: number;
      perHour: number;
      perDay: number;
      maxConcurrent: number;
    };
  } | null;
  walletBalance: string;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: MembershipRole;
  }>;
}

export interface UpdateProfileDto {
  name?: string;
  avatarUrl?: string;
}

// API Key management
export interface CreateApiKeyDto {
  name: string;
  scopes?: string[];
  allowedModels?: string[];
  allowedIps?: string[];
  expiresAt?: Date;
}

export interface ApiKeyResponse {
  id: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  allowedModels: string[];
  allowedIps: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  usageCount: string;
}

export interface ApiKeyCreatedResponse extends ApiKeyResponse {
  key: string; // Full key, only shown once
}

// Usage
export interface UsageSummaryResponse {
  period: {
    start: Date;
    end: Date;
  };
  allowance: {
    daily: number;
    used: number;
    remaining: number;
  };
  requests: {
    total: number;
    successful: number;
    failed: number;
  };
  tokens: {
    input: string;
    output: string;
  };
  cost: {
    actual: string; // Our cost
    equivalent: string; // What it would cost directly
    savings: string; // equivalent - actual
  };
  byModel: Array<{
    model: string;
    requests: number;
    inputTokens: string;
    outputTokens: string;
    cost: string;
  }>;
  daily: Array<{
    date: string;
    requests: number;
    tokens: string;
    cost: string;
  }>;
}

export interface UsageHistoryQuery {
  startDate?: string;
  endDate?: string;
  model?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface RequestHistoryItem {
  id: string;
  requestId: string;
  model: string;
  provider: string;
  status: string;
  statusCode: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: number | null;
  createdAt: Date;
}

// Wallet
export interface WalletResponse {
  balance: string;
  isLocked: boolean;
  lockedReason: string | null;
  totals: {
    topup: string;
    spent: string;
  };
}

export interface WalletLedgerItem {
  id: string;
  txType: WalletTxType;
  amountCents: string;
  balanceAfter: string;
  description: string | null;
  createdAt: Date;
}

export interface WalletLedgerQuery {
  txType?: WalletTxType;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

// Billing
export interface BillingOverviewResponse {
  subscription: {
    id: string;
    planName: string;
    status: SubscriptionStatus;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    priceMonthly: number;
  } | null;
  wallet: WalletResponse;
  topupPackages: Array<{
    id: string;
    name: string;
    description: string | null;
    amountCents: number;
    creditCents: number;
    isPopular: boolean;
  }>;
  availablePlans: Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    priceMonthly: number;
    priceYearly: number;
    dailyAllowance: number;
    features: string[];
  }>;
}

// Organization management (for org owners/admins)
export interface CreateOrganizationDto {
  name: string;
  slug: string;
}

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  maxSeats: number;
  isActive: boolean;
  createdAt: Date;
  membership: {
    role: MembershipRole;
    joinedAt: Date;
  };
  subscription: {
    id: string;
    planName: string;
    status: SubscriptionStatus;
    currentPeriodEnd: Date;
    seatCount: number;
  } | null;
  walletBalance: string;
  memberCount: number;
}

export interface OrganizationMemberResponse {
  userId: string;
  email: string;
  name: string | null;
  role: MembershipRole;
  status: string;
  joinedAt: Date;
}

export interface InviteMemberDto {
  email: string;
  role?: MembershipRole;
}

export interface UpdateMemberRoleDto {
  role: MembershipRole;
}

// Project management
export interface CreateProjectDto {
  name: string;
  slug: string;
  description?: string;
}

export interface ProjectResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  apiKeyCount: number;
}

// Notification preferences
export interface NotificationPreferencesResponse {
  emailUsageAlerts: boolean;
  emailBillingAlerts: boolean;
  emailSecurityAlerts: boolean;
  emailProductUpdates: boolean;
  usageAlertThreshold: number;
}

export interface UpdateNotificationPreferencesDto {
  emailUsageAlerts?: boolean;
  emailBillingAlerts?: boolean;
  emailSecurityAlerts?: boolean;
  emailProductUpdates?: boolean;
  usageAlertThreshold?: number;
}

// Pagination
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}