import { Injectable, NotFoundException, ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ApiKeyService } from '../auth/api-key.service';
import {
  UserProfileResponse,
  UpdateProfileDto,
  CreateApiKeyDto,
  ApiKeyResponse,
  ApiKeyCreatedResponse,
  UsageSummaryResponse,
  UsageHistoryQuery,
  RequestHistoryItem,
  WalletResponse,
  WalletLedgerItem,
  WalletLedgerQuery,
  BillingOverviewResponse,
  CreateOrganizationDto,
  OrganizationResponse,
  OrganizationMemberResponse,
  InviteMemberDto,
  UpdateMemberRoleDto,
  CreateProjectDto,
  ProjectResponse,
  NotificationPreferencesResponse,
  UpdateNotificationPreferencesDto,
  PaginatedResponse,
} from './interfaces/account.interfaces';
import { Prisma, MembershipRole, AuditAction, ApiKeyOwnerType } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  // ==================== PROFILE ====================

  async getProfile(userId: string): Promise<UserProfileResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscription: {
          include: { plan: true },
        },
        walletBalance: true,
        memberships: {
          include: { organization: true },
          where: { status: 'ACTIVE' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isActive: user.isActive,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      subscription: user.subscription
        ? {
            id: user.subscription.id,
            planId: user.subscription.planId,
            planName: user.subscription.plan.name,
            planSlug: user.subscription.plan.slug,
            status: user.subscription.status,
            currentPeriodStart: user.subscription.currentPeriodStart,
            currentPeriodEnd: user.subscription.currentPeriodEnd,
            cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
            dailyAllowance: user.subscription.plan.dailyAllowance,
            limits: {
              perMinute: user.subscription.plan.limitPerMinute,
              perHour: user.subscription.plan.limitPerHour,
              perDay: user.subscription.plan.limitPerDay,
              maxConcurrent: user.subscription.plan.maxConcurrent,
            },
          }
        : null,
      walletBalance: user.walletBalance?.balanceCents.toString() || '0',
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserProfileResponse> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        avatarUrl: dto.avatarUrl,
      },
    });

    return this.getProfile(userId);
  }

  // ==================== API KEYS ====================

  async getUserApiKeys(userId: string): Promise<ApiKeyResponse[]> {
    const keys = await this.prisma.apiKey.findMany({
      where: {
        userId,
        ownerType: ApiKeyOwnerType.USER,
      },
      orderBy: { createdAt: 'desc' },
    });

    return keys.map((k) => ({
      id: k.id,
      keyPrefix: k.keyPrefix,
      name: k.name,
      scopes: k.scopes as string[],
      allowedModels: k.allowedModels as string[],
      allowedIps: k.allowedIps as string[],
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
      usageCount: k.usageCount.toString(),
    }));
  }

  async createUserApiKey(userId: string, dto: CreateApiKeyDto): Promise<ApiKeyCreatedResponse> {
    // Generate key
    const keyPlain = `omni_${crypto.randomBytes(32).toString('hex')}`;
    const keyPrefix = keyPlain.substring(0, 12);
    const keyHash = crypto.createHash('sha256').update(keyPlain).digest('hex');

    const key = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        keyPrefix,
        keyHash,
        ownerType: ApiKeyOwnerType.USER,
        userId,
        scopes: dto.scopes || ['chat:write', 'embeddings:write'],
        allowedModels: dto.allowedModels || [],
        allowedIps: dto.allowedIps || [],
        expiresAt: dto.expiresAt,
      },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        actorType: 'user',
        action: AuditAction.API_KEY_CREATED,
        targetType: 'api_key',
        targetId: key.id,
        metadata: { keyPrefix },
      },
    });

    return {
      id: key.id,
      key: keyPlain, // Only returned once
      keyPrefix: key.keyPrefix,
      name: key.name,
      scopes: key.scopes as string[],
      allowedModels: key.allowedModels as string[],
      allowedIps: key.allowedIps as string[],
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      usageCount: key.usageCount.toString(),
    };
  }

  async revokeUserApiKey(userId: string, keyId: string): Promise<void> {
    const key = await this.prisma.apiKey.findFirst({
      where: {
        id: keyId,
        userId,
        ownerType: ApiKeyOwnerType.USER,
      },
    });

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    if (!key.isActive || key.revokedAt) {
      throw new ConflictException('API key is already revoked');
    }

    await this.prisma.$transaction([
      this.prisma.apiKey.update({
        where: { id: keyId },
        data: {
          isActive: false,
          revokedAt: new Date(),
          revokedReason: 'Revoked by user',
        },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: userId,
          actorType: 'user',
          action: AuditAction.API_KEY_REVOKED,
          targetType: 'api_key',
          targetId: keyId,
          metadata: { keyPrefix: key.keyPrefix },
        },
      }),
    ]);

    // Remove from Redis cache
    await this.redis.del(`apikey:${key.keyHash}`);
  }

  // ==================== USAGE ====================

  async getUsageSummary(userId: string, startDate?: Date, endDate?: Date): Promise<UsageSummaryResponse> {
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate || new Date();

    // Get subscription for allowance info
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscription: { include: { plan: true } },
      },
    });

    const dailyAllowance = user?.subscription?.plan.dailyAllowance || 0;

    // Get today's usage from Redis or calculate
    const today = new Date().toISOString().split('T')[0];
    const todayUsageKey = `usage:USER:${userId}:${today}`;
    let todayUsed = 0;
    const cachedUsage = await this.redis.get(todayUsageKey);
    if (cachedUsage) {
      todayUsed = parseInt(cachedUsage, 10);
    } else {
      const todayStart = new Date(today);
      const todayEnd = new Date(today);
      todayEnd.setDate(todayEnd.getDate() + 1);
      todayUsed = await this.prisma.requestEvent.count({
        where: {
          ownerType: 'USER',
          ownerId: userId,
          createdAt: { gte: todayStart, lt: todayEnd },
        },
      });
    }

    // Get aggregated stats
    const [stats, byModel, daily] = await Promise.all([
      this.prisma.requestEvent.aggregate({
        where: {
          ownerType: 'USER',
          ownerId: userId,
          createdAt: { gte: start, lte: end },
        },
        _count: true,
        _sum: {
          inputTokens: true,
          outputTokens: true,
          costCents: true,
        },
      }),
      this.prisma.requestEvent.groupBy({
        by: ['model'],
        where: {
          ownerType: 'USER',
          ownerId: userId,
          createdAt: { gte: start, lte: end },
        },
        _count: true,
        _sum: {
          inputTokens: true,
          outputTokens: true,
          costCents: true,
        },
      }),
      this.prisma.usageDaily.findMany({
        where: {
          ownerType: 'USER',
          ownerId: userId,
          date: { gte: start, lte: end },
        },
        orderBy: { date: 'asc' },
      }),
    ]);

    const successCount = await this.prisma.requestEvent.count({
      where: {
        ownerType: 'USER',
        ownerId: userId,
        createdAt: { gte: start, lte: end },
        status: 'SUCCESS',
      },
    });

    const actualCost = stats._sum.costCents || 0;
    // For equivalent cost, we'd need to calculate based on original pricing
    // For now, use a multiplier (e.g., our prices are 70% of original)
    const equivalentCost = Math.round(actualCost / 0.7);

    return {
      period: { start, end },
      allowance: {
        daily: dailyAllowance,
        used: todayUsed,
        remaining: Math.max(0, dailyAllowance - todayUsed),
      },
      requests: {
        total: stats._count,
        successful: successCount,
        failed: stats._count - successCount,
      },
      tokens: {
        input: (stats._sum.inputTokens || 0).toString(),
        output: (stats._sum.outputTokens || 0).toString(),
      },
      cost: {
        actual: actualCost.toString(),
        equivalent: equivalentCost.toString(),
        savings: (equivalentCost - actualCost).toString(),
      },
      byModel: byModel.map((m) => ({
        model: m.model,
        requests: m._count,
        inputTokens: (m._sum.inputTokens || 0).toString(),
        outputTokens: (m._sum.outputTokens || 0).toString(),
        cost: (m._sum.costCents || 0).toString(),
      })),
      daily: daily.map((d) => ({
        date: d.date.toISOString().split('T')[0],
        requests: d.requestCount,
        tokens: (d.totalInputTokens + d.totalOutputTokens).toString(),
        cost: d.totalCostCents.toString(),
      })),
    };
  }

  async getRequestHistory(
    userId: string,
    query: UsageHistoryQuery,
  ): Promise<PaginatedResponse<RequestHistoryItem>> {
    const { page = 1, limit = 50, model, status, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.RequestEventWhereInput = {
      ownerType: 'USER',
      ownerId: userId,
    };

    if (model) where.model = model;
    if (status) where.status = status as any;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [requests, total] = await Promise.all([
      this.prisma.requestEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.requestEvent.count({ where }),
    ]);

    return {
      data: requests.map((r) => ({
        id: r.id,
        requestId: r.requestId,
        model: r.model,
        provider: r.provider,
        status: r.status,
        statusCode: r.statusCode,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costCents: r.costCents,
        createdAt: r.createdAt,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ==================== WALLET ====================

  async getWallet(userId: string): Promise<WalletResponse> {
    const wallet = await this.prisma.walletBalance.findUnique({
      where: { userId },
    });

    if (!wallet) {
      return {
        balance: '0',
        isLocked: false,
        lockedReason: null,
        totals: {
          topup: '0',
          spent: '0',
        },
      };
    }

    return {
      balance: wallet.balanceCents.toString(),
      isLocked: wallet.isLocked,
      lockedReason: wallet.lockedReason,
      totals: {
        topup: wallet.totalTopupCents.toString(),
        spent: wallet.totalSpentCents.toString(),
      },
    };
  }

  async getWalletLedger(
    userId: string,
    query: WalletLedgerQuery,
  ): Promise<PaginatedResponse<WalletLedgerItem>> {
    const { page = 1, limit = 50, txType, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.WalletLedgerWhereInput = { userId };
    if (txType) where.txType = txType;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [entries, total] = await Promise.all([
      this.prisma.walletLedger.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.walletLedger.count({ where }),
    ]);

    return {
      data: entries.map((e) => ({
        id: e.id,
        txType: e.txType,
        amountCents: e.amountCents.toString(),
        balanceAfter: e.balanceAfter.toString(),
        description: e.description,
        createdAt: e.createdAt,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ==================== BILLING ====================

  async getBillingOverview(userId: string): Promise<BillingOverviewResponse> {
    const [user, topupPackages, plans] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          subscription: { include: { plan: true } },
          walletBalance: true,
        },
      }),
      this.prisma.topupPackage.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.plan.findMany({
        where: { isActive: true, isPublic: true },
        orderBy: { priceMonthly: 'asc' },
      }),
    ]);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      subscription: user.subscription
        ? {
            id: user.subscription.id,
            planName: user.subscription.plan.name,
            status: user.subscription.status,
            currentPeriodEnd: user.subscription.currentPeriodEnd,
            cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
            priceMonthly: user.subscription.plan.priceMonthly,
          }
        : null,
      wallet: {
        balance: user.walletBalance?.balanceCents.toString() || '0',
        isLocked: user.walletBalance?.isLocked || false,
        lockedReason: user.walletBalance?.lockedReason || null,
        totals: {
          topup: user.walletBalance?.totalTopupCents.toString() || '0',
          spent: user.walletBalance?.totalSpentCents.toString() || '0',
        },
      },
      topupPackages: topupPackages.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        amountCents: p.amountCents,
        creditCents: p.creditCents,
        isPopular: p.isPopular,
      })),
      availablePlans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        dailyAllowance: p.dailyAllowance,
        features: this.getPlanFeatures(p),
      })),
    };
  }

  private getPlanFeatures(plan: any): string[] {
    const features: string[] = [];
    features.push(`${plan.dailyAllowance} requests/day`);
    features.push(`${plan.limitPerMinute} requests/minute`);
    features.push(`${plan.maxConcurrent} concurrent requests`);
    if (plan.hasStreaming) features.push('Streaming support');
    if (plan.hasWalletAccess) features.push('Wallet/top-up access');
    if (plan.hasPriorityQueue) features.push('Priority queue');
    if (plan.maxSeats > 1) features.push(`Up to ${plan.maxSeats} team members`);
    return features;
  }

  // ==================== ORGANIZATIONS ====================

  async getUserOrganizations(userId: string): Promise<OrganizationResponse[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: {
        organization: {
          include: {
            subscription: { include: { plan: true } },
            walletBalance: true,
            _count: { select: { memberships: true } },
          },
        },
      },
    });

    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      maxSeats: m.organization.maxSeats,
      isActive: m.organization.isActive,
      createdAt: m.organization.createdAt,
      membership: {
        role: m.role,
        joinedAt: m.createdAt,
      },
      subscription: m.organization.subscription
        ? {
            id: m.organization.subscription.id,
            planName: m.organization.subscription.plan.name,
            status: m.organization.subscription.status,
            currentPeriodEnd: m.organization.subscription.currentPeriodEnd,
            seatCount: m.organization.subscription.seatCount,
          }
        : null,
      walletBalance: m.organization.walletBalance?.balanceCents.toString() || '0',
      memberCount: m.organization._count.memberships,
    }));
  }

  async createOrganization(userId: string, dto: CreateOrganizationDto): Promise<OrganizationResponse> {
    // Check for duplicate slug
    const existing = await this.prisma.organization.findUnique({
      where: { slug: dto.slug },
    });

    if (existing) {
      throw new ConflictException(`Organization with slug "${dto.slug}" already exists`);
    }

    const org = await this.prisma.$transaction(async (tx) => {
      // Create organization
      const newOrg = await tx.organization.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          ownerId: userId,
        },
      });

      // Create owner membership
      await tx.membership.create({
        data: {
          userId,
          organizationId: newOrg.id,
          role: MembershipRole.OWNER,
          status: 'ACTIVE',
        },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          actorId: userId,
          actorType: 'user',
          action: AuditAction.ORG_CREATED,
          targetType: 'organization',
          targetId: newOrg.id,
          metadata: { name: dto.name, slug: dto.slug },
        },
      });

      return newOrg;
    });

    const orgs = await this.getUserOrganizations(userId);
    return orgs.find((o) => o.id === org.id)!;
  }

  async getOrganizationMembers(userId: string, orgId: string): Promise<OrganizationMemberResponse[]> {
    // Verify user has access
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const members = await this.prisma.membership.findMany({
      where: { organizationId: orgId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      status: m.status,
      joinedAt: m.createdAt,
    }));
  }

  async inviteMember(userId: string, orgId: string, dto: InviteMemberDto): Promise<{ invitationId: string; token: string }> {
    // Verify user has permission (OWNER or ADMIN)
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new ForbiddenException('You do not have permission to invite members');
    }

    // Check if user is already a member
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      const existingMembership = await this.prisma.membership.findUnique({
        where: { userId_organizationId: { userId: existingUser.id, organizationId: orgId } },
      });

      if (existingMembership) {
        throw new ConflictException('User is already a member of this organization');
      }
    }

    // Check seat limit
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: { _count: { select: { memberships: true } } },
    });

    if (org && org._count.memberships >= org.maxSeats) {
      throw new BadRequestException('Organization has reached its seat limit');
    }

    // Create invitation
    const token = crypto.randomBytes(32).toString('hex');
    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        organizationId: orgId,
        invitedById: userId,
        email: dto.email,
        role: dto.role || MembershipRole.DEVELOPER,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        actorType: 'user',
        action: AuditAction.MEMBER_INVITED,
        targetType: 'organization',
        targetId: orgId,
        metadata: { email: dto.email, role: dto.role },
      },
    });

    return { invitationId: invitation.id, token };
  }

  async updateMemberRole(userId: string, orgId: string, targetUserId: string, dto: UpdateMemberRoleDto): Promise<void> {
    // Verify user has permission (OWNER only for role changes)
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
    });

    if (!membership || membership.role !== 'OWNER') {
      throw new ForbiddenException('Only organization owners can change member roles');
    }

    // Cannot change own role
    if (userId === targetUserId) {
      throw new BadRequestException('You cannot change your own role');
    }

    const targetMembership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: targetUserId, organizationId: orgId } },
    });

    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    await this.prisma.$transaction([
      this.prisma.membership.update({
        where: { userId_organizationId: { userId: targetUserId, organizationId: orgId } },
        data: { role: dto.role },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: userId,
          actorType: 'user',
          action: AuditAction.MEMBER_ROLE_CHANGED,
          targetType: 'membership',
          targetId: targetMembership.id,
          metadata: { oldRole: targetMembership.role, newRole: dto.role },
        },
      }),
    ]);
  }

  async removeMember(userId: string, orgId: string, targetUserId: string): Promise<void> {
    // Verify user has permission (OWNER or ADMIN, or removing self)
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const isSelf = userId === targetUserId;
    const hasPermission = ['OWNER', 'ADMIN'].includes(membership.role);

    if (!isSelf && !hasPermission) {
      throw new ForbiddenException('You do not have permission to remove members');
    }

    const targetMembership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: targetUserId, organizationId: orgId } },
    });

    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    // Cannot remove the owner
    if (targetMembership.role === 'OWNER' && !isSelf) {
      throw new BadRequestException('Cannot remove the organization owner');
    }

    await this.prisma.$transaction([
      this.prisma.membership.delete({
        where: { userId_organizationId: { userId: targetUserId, organizationId: orgId } },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: userId,
          actorType: 'user',
          action: AuditAction.MEMBER_REMOVED,
          targetType: 'organization',
          targetId: orgId,
          metadata: { removedUserId: targetUserId, wasSelf: isSelf },
        },
      }),
    ]);
  }

  // ==================== PROJECTS ====================

  async getOrgProjects(userId: string, orgId: string): Promise<ProjectResponse[]> {
    // Verify user has access
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const projects = await this.prisma.project.findMany({
      where: { organizationId: orgId },
      include: { _count: { select: { apiKeys: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      isActive: p.isActive,
      createdAt: p.createdAt,
      apiKeyCount: p._count.apiKeys,
    }));
  }

  async createProject(userId: string, orgId: string, dto: CreateProjectDto): Promise<ProjectResponse> {
    // Verify user has permission (OWNER or ADMIN)
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
    });

    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      throw new ForbiddenException('You do not have permission to create projects');
    }

    // Check for duplicate slug within org
    const existing = await this.prisma.project.findUnique({
      where: { organizationId_slug: { organizationId: orgId, slug: dto.slug } },
    });

    if (existing) {
      throw new ConflictException(`Project with slug "${dto.slug}" already exists in this organization`);
    }

    const project = await this.prisma.project.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        organizationId: orgId,
      },
      include: { _count: { select: { apiKeys: true } } },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        actorType: 'user',
        action: AuditAction.PROJECT_CREATED,
        targetType: 'project',
        targetId: project.id,
        metadata: { name: dto.name, slug: dto.slug, orgId },
      },
    });

    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      isActive: project.isActive,
      createdAt: project.createdAt,
      apiKeyCount: project._count.apiKeys,
    };
  }

  // ==================== NOTIFICATION PREFERENCES ====================

  async getNotificationPreferences(userId: string): Promise<NotificationPreferencesResponse> {
    let prefs = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });

    if (!prefs) {
      // Create default preferences
      prefs = await this.prisma.notificationPreference.create({
        data: { userId },
      });
    }

    return {
      emailUsageAlerts: prefs.emailUsageAlerts,
      emailBillingAlerts: prefs.emailBillingAlerts,
      emailSecurityAlerts: prefs.emailSecurityAlerts,
      emailProductUpdates: prefs.emailProductUpdates,
      usageAlertThreshold: prefs.usageAlertThreshold,
    };
  }

  async updateNotificationPreferences(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponse> {
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        ...dto,
      },
      update: dto,
    });

    return this.getNotificationPreferences(userId);
  }
}