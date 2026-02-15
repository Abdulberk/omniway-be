import { SubscriptionStatus, WalletTxType } from '@prisma/client';

/**
 * Admin interfaces for management APIs
 */

// Plan management
export interface CreatePlanDto {
    name: string;
    slug: string;
    description?: string;
    stripePriceId?: string;
    stripeProductId?: string;
    priceMonthly?: number;
    priceYearly?: number;
    limitPerMinute?: number;
    limitPerHour?: number;
    limitPerDay?: number;
    dailyAllowance?: number;
    maxConcurrent?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxBodyBytes?: number;
    maxSeats?: number;
    pricePerSeat?: number;
    allowedModels?: string[];
    isActive?: boolean;
    isPublic?: boolean;
    isFree?: boolean;
    hasWalletAccess?: boolean;
    hasStreaming?: boolean;
    hasPriorityQueue?: boolean;
}

export interface UpdatePlanDto extends Partial<CreatePlanDto> { }

export interface PlanResponse {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    stripePriceId: string | null;
    stripeProductId: string | null;
    priceMonthly: number;
    priceYearly: number;
    limitPerMinute: number;
    limitPerHour: number;
    limitPerDay: number;
    dailyAllowance: number;
    maxConcurrent: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxBodyBytes: number;
    maxSeats: number;
    pricePerSeat: number;
    allowedModels: string[];
    isActive: boolean;
    isPublic: boolean;
    isFree: boolean;
    hasWalletAccess: boolean;
    hasStreaming: boolean;
    hasPriorityQueue: boolean;
    createdAt: Date;
    updatedAt: Date;
}

// User management
export interface AdminUserResponse {
    id: string;
    email: string;
    name: string | null;
    isActive: boolean;
    isSuperAdmin: boolean;
    stripeCustomerId: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
    subscription?: {
        id: string;
        planId: string;
        planName: string;
        status: SubscriptionStatus;
        currentPeriodEnd: Date;
    } | null;
    walletBalance?: string;
}

export interface UpdateUserDto {
    name?: string;
    isActive?: boolean;
    isSuperAdmin?: boolean;
}

// Organization management
export interface AdminOrgResponse {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
    ownerEmail: string;
    maxSeats: number;
    isActive: boolean;
    stripeCustomerId: string | null;
    createdAt: Date;
    memberCount: number;
    subscription?: {
        id: string;
        planId: string;
        planName: string;
        status: SubscriptionStatus;
        currentPeriodEnd: Date;
    } | null;
    walletBalance?: string;
}

export interface UpdateOrgDto {
    name?: string;
    maxSeats?: number;
    isActive?: boolean;
}

// Model catalog management
export interface CreateModelDto {
    modelId: string;
    provider: string;
    displayName: string;
    description?: string;
    upstreamModelId: string;
    supportsStreaming?: boolean;
    supportsVision?: boolean;
    supportsToolCalls?: boolean;
    supportsFunctionCall?: boolean;
    supportsJson?: boolean;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    isActive?: boolean;
    sortOrder?: number;
    category?: string;
}

export interface UpdateModelDto extends Partial<CreateModelDto> { }

export interface ModelResponse {
    id: string;
    modelId: string;
    provider: string;
    displayName: string;
    description: string | null;
    upstreamModelId: string;
    supportsStreaming: boolean;
    supportsVision: boolean;
    supportsToolCalls: boolean;
    supportsFunctionCall: boolean;
    supportsJson: boolean;
    maxContextTokens: number;
    maxOutputTokens: number;
    isActive: boolean;
    isDeprecated: boolean;
    sortOrder: number;
    category: string | null;
    createdAt: Date;
    updatedAt: Date;
}

// Model pricing management
export interface CreateModelPricingDto {
    modelId: string;
    inputPricePer1M: number;
    outputPricePer1M: number;
    originalInputPrice: number;
    originalOutputPrice: number;
    effectiveFrom?: Date;
    effectiveTo?: Date;
}

export interface ModelPricingResponse {
    id: string;
    modelId: string;
    inputPricePer1M: number;
    outputPricePer1M: number;
    originalInputPrice: number;
    originalOutputPrice: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    createdAt: Date;
}

// Wallet adjustment
export interface WalletAdjustmentDto {
    amountCents: number;
    reason: string;
    txType?: WalletTxType;
}

// Usage overview
export interface UsageOverviewResponse {
    totalRequests: number;
    totalSuccessful: number;
    totalErrors: number;
    totalInputTokens: string;
    totalOutputTokens: string;
    totalCostCents: string;
    period: {
        start: Date;
        end: Date;
    };
    byModel: Array<{
        model: string;
        requestCount: number;
        inputTokens: string;
        outputTokens: string;
    }>;
}

// API key management (admin)
export interface AdminApiKeyResponse {
    id: string;
    keyPrefix: string;
    name: string;
    ownerType: string;
    userId: string | null;
    projectId: string | null;
    isActive: boolean;
    lastUsedAt: Date | null;
    createdAt: Date;
    usageCount: string;
}

// Audit logs
export interface AuditLogResponse {
    id: string;
    actorId: string | null;
    actorType: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown> | null;
    ipAddress: string | null;
    createdAt: Date;
}

// Topup package management
export interface CreateTopupPackageDto {
    name: string;
    description?: string;
    amountCents: number;
    creditCents: number;
    stripePriceId?: string;
    isActive?: boolean;
    isPopular?: boolean;
    sortOrder?: number;
}

export interface UpdateTopupPackageDto extends Partial<CreateTopupPackageDto> { }

export interface TopupPackageResponse {
    id: string;
    name: string;
    description: string | null;
    amountCents: number;
    creditCents: number;
    stripePriceId: string | null;
    isActive: boolean;
    isPopular: boolean;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
}

// Pagination
export interface PaginationQuery {
    page?: number;
    limit?: number;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
    data: T[];
    meta: {
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    };
}