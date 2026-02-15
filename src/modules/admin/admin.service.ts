import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  CreatePlanDto,
  UpdatePlanDto,
  CreateModelDto,
  UpdateModelDto,
  CreateModelPricingDto,
  UpdateUserDto,
  UpdateOrgDto,
  WalletAdjustmentDto,
  PaginationQuery,
  PlanResponse,
  ModelResponse,
  ModelPricingResponse,
  AdminUserResponse,
  AdminOrgResponse,
  AdminApiKeyResponse,
  UsageOverviewResponse,
  AuditLogResponse,
  PaginatedResponse,
  CreateTopupPackageDto,
  UpdateTopupPackageDto,
  TopupPackageResponse,
} from './interfaces/admin.interfaces';
import {
  WalletTxType,
  AuditAction,
  Prisma,
  ApiKeyOwnerType,
} from '@prisma/client';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) { }

  // ==================== PLAN MANAGEMENT ====================

  async createPlan(dto: CreatePlanDto): Promise<PlanResponse> {
    // Check for duplicate slug
    const existing = await this.prisma.plan.findUnique({
      where: { slug: dto.slug },
    });

    if (existing) {
      throw new ConflictException(
        `Plan with slug "${dto.slug}" already exists`,
      );
    }

    const plan = await this.prisma.plan.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        isActive: dto.isActive ?? true,
        isPublic: dto.isPublic ?? true,
        isFree: dto.isFree ?? false,
        limitPerMinute: dto.limitPerMinute ?? 20,
        limitPerHour: dto.limitPerHour ?? 100,
        limitPerDay: dto.limitPerDay ?? 500,
        dailyAllowance: dto.dailyAllowance ?? 500,
        maxConcurrent: dto.maxConcurrent ?? 5,
        maxInputTokens: dto.maxInputTokens ?? 8000,
        maxOutputTokens: dto.maxOutputTokens ?? 4000,
        maxBodyBytes: dto.maxBodyBytes ?? 1048576,
        maxSeats: dto.maxSeats ?? 1,
        pricePerSeat: dto.pricePerSeat ?? 0,
        priceMonthly: dto.priceMonthly ?? 0,
        priceYearly: dto.priceYearly ?? 0,
        stripePriceId: dto.stripePriceId,
        stripeProductId: dto.stripeProductId,
        allowedModels: dto.allowedModels ?? [],
        hasWalletAccess: dto.hasWalletAccess ?? true,
        hasStreaming: dto.hasStreaming ?? true,
        hasPriorityQueue: dto.hasPriorityQueue ?? false,
      },
    });

    return this.mapPlanToResponse(plan);
  }

  async getPlans(
    params: PaginationQuery,
  ): Promise<PaginatedResponse<PlanResponse>> {
    const {
      page = 1,
      limit = 20,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.PlanWhereInput = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [plans, total] = await Promise.all([
      this.prisma.plan.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.plan.count({ where }),
    ]);

    return {
      data: plans.map((p) => this.mapPlanToResponse(p)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getPlan(id: string): Promise<PlanResponse> {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
    });

    if (!plan) {
      throw new NotFoundException(`Plan with id "${id}" not found`);
    }

    return this.mapPlanToResponse(plan);
  }

  async updatePlan(id: string, dto: UpdatePlanDto): Promise<PlanResponse> {
    const existing = await this.prisma.plan.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Plan with id "${id}" not found`);
    }

    // Check for slug conflict
    if (dto.slug && dto.slug !== existing.slug) {
      const slugConflict = await this.prisma.plan.findUnique({
        where: { slug: dto.slug },
      });
      if (slugConflict) {
        throw new ConflictException(
          `Plan with slug "${dto.slug}" already exists`,
        );
      }
    }

    const plan = await this.prisma.plan.update({
      where: { id },
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        isActive: dto.isActive,
        isPublic: dto.isPublic,
        isFree: dto.isFree,
        limitPerMinute: dto.limitPerMinute,
        limitPerHour: dto.limitPerHour,
        limitPerDay: dto.limitPerDay,
        dailyAllowance: dto.dailyAllowance,
        maxConcurrent: dto.maxConcurrent,
        maxInputTokens: dto.maxInputTokens,
        maxOutputTokens: dto.maxOutputTokens,
        maxBodyBytes: dto.maxBodyBytes,
        maxSeats: dto.maxSeats,
        pricePerSeat: dto.pricePerSeat,
        priceMonthly: dto.priceMonthly,
        priceYearly: dto.priceYearly,
        stripePriceId: dto.stripePriceId,
        stripeProductId: dto.stripeProductId,
        allowedModels: dto.allowedModels,
        hasWalletAccess: dto.hasWalletAccess,
        hasStreaming: dto.hasStreaming,
        hasPriorityQueue: dto.hasPriorityQueue,
      },
    });

    // Invalidate policy caches for all subscriptions using this plan
    await this.invalidatePlanPolicyCaches(id);

    return this.mapPlanToResponse(plan);
  }

  async deletePlan(id: string): Promise<void> {
    const existing = await this.prisma.plan.findUnique({
      where: { id },
      include: { subscriptions: { take: 1 } },
    });

    if (!existing) {
      throw new NotFoundException(`Plan with id "${id}" not found`);
    }

    if (existing.subscriptions.length > 0) {
      throw new ConflictException(
        'Cannot delete plan with active subscriptions',
      );
    }

    await this.prisma.plan.delete({
      where: { id },
    });
  }

  // ==================== MODEL CATALOG MANAGEMENT ====================

  async createModel(dto: CreateModelDto): Promise<ModelResponse> {
    const existing = await this.prisma.modelCatalog.findUnique({
      where: { modelId: dto.modelId },
    });

    if (existing) {
      throw new ConflictException(`Model "${dto.modelId}" already exists`);
    }

    const model = await this.prisma.modelCatalog.create({
      data: {
        modelId: dto.modelId,
        displayName: dto.displayName,
        description: dto.description,
        provider: dto.provider,
        upstreamModelId: dto.upstreamModelId,
        supportsStreaming: dto.supportsStreaming ?? true,
        supportsVision: dto.supportsVision ?? false,
        supportsToolCalls: dto.supportsToolCalls ?? false,
        supportsFunctionCall: dto.supportsFunctionCall ?? false,
        supportsJson: dto.supportsJson ?? false,
        maxContextTokens: dto.maxContextTokens ?? 8192,
        maxOutputTokens: dto.maxOutputTokens ?? 4096,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
        category: dto.category,
      },
    });

    return this.mapModelToResponse(model);
  }

  async getModels(
    params: PaginationQuery & { provider?: string; category?: string },
  ): Promise<PaginatedResponse<ModelResponse>> {
    const {
      page = 1,
      limit = 50,
      search,
      provider,
      category,
      sortBy = 'sortOrder',
      sortOrder = 'asc',
    } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.ModelCatalogWhereInput = {};
    if (search) {
      where.OR = [
        { modelId: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (provider) where.provider = provider;
    if (category) where.category = category;

    const [models, total] = await Promise.all([
      this.prisma.modelCatalog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.modelCatalog.count({ where }),
    ]);

    return {
      data: models.map((m) => this.mapModelToResponse(m)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getModel(id: string): Promise<ModelResponse> {
    const model = await this.prisma.modelCatalog.findUnique({
      where: { id },
    });

    if (!model) {
      throw new NotFoundException(`Model with id "${id}" not found`);
    }

    return this.mapModelToResponse(model);
  }

  async updateModel(id: string, dto: UpdateModelDto): Promise<ModelResponse> {
    const existing = await this.prisma.modelCatalog.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Model with id "${id}" not found`);
    }

    if (dto.modelId && dto.modelId !== existing.modelId) {
      const conflict = await this.prisma.modelCatalog.findUnique({
        where: { modelId: dto.modelId },
      });
      if (conflict) {
        throw new ConflictException(`Model "${dto.modelId}" already exists`);
      }
    }

    const model = await this.prisma.modelCatalog.update({
      where: { id },
      data: {
        modelId: dto.modelId,
        displayName: dto.displayName,
        description: dto.description,
        provider: dto.provider,
        upstreamModelId: dto.upstreamModelId,
        supportsStreaming: dto.supportsStreaming,
        supportsVision: dto.supportsVision,
        supportsToolCalls: dto.supportsToolCalls,
        supportsFunctionCall: dto.supportsFunctionCall,
        supportsJson: dto.supportsJson,
        maxContextTokens: dto.maxContextTokens,
        maxOutputTokens: dto.maxOutputTokens,
        isActive: dto.isActive,
        sortOrder: dto.sortOrder,
        category: dto.category,
      },
    });

    return this.mapModelToResponse(model);
  }

  async deleteModel(id: string): Promise<void> {
    const existing = await this.prisma.modelCatalog.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Model with id "${id}" not found`);
    }

    await this.prisma.modelCatalog.delete({
      where: { id },
    });
  }

  // ==================== MODEL PRICING MANAGEMENT ====================

  async createModelPricing(
    dto: CreateModelPricingDto,
  ): Promise<ModelPricingResponse> {
    // Verify model exists
    const model = await this.prisma.modelCatalog.findUnique({
      where: { modelId: dto.modelId },
    });

    if (!model) {
      throw new NotFoundException(
        `Model with modelId "${dto.modelId}" not found`,
      );
    }

    // Check for overlapping pricing
    const effectiveTo = dto.effectiveTo || new Date('2099-12-31');
    const effectiveFrom = dto.effectiveFrom || new Date();

    const overlapping = await this.prisma.modelRequestPricing.findFirst({
      where: {
        modelId: model.id,
        effectiveFrom: { lte: effectiveTo },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }],
      },
    });

    if (overlapping) {
      throw new ConflictException(
        'Pricing period overlaps with existing pricing',
      );
    }

    const pricing = await this.prisma.modelRequestPricing.create({
      data: {
        modelId: model.id,
        inputPricePer1M: dto.inputPricePer1M,
        outputPricePer1M: dto.outputPricePer1M,
        originalInputPrice: dto.originalInputPrice,
        originalOutputPrice: dto.originalOutputPrice,
        effectiveFrom,
        effectiveTo: dto.effectiveTo,
      },
      include: {
        model: true,
      },
    });

    return this.mapPricingToResponse(pricing);
  }

  async getModelPricing(
    params: PaginationQuery & { modelId?: string },
  ): Promise<PaginatedResponse<ModelPricingResponse>> {
    const { page = 1, limit = 50, modelId } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.ModelRequestPricingWhereInput = {};
    if (modelId) {
      const model = await this.prisma.modelCatalog.findUnique({
        where: { modelId },
      });
      if (model) {
        where.modelId = model.id;
      }
    }

    const [pricings, total] = await Promise.all([
      this.prisma.modelRequestPricing.findMany({
        where,
        skip,
        take: limit,
        orderBy: { effectiveFrom: 'desc' },
        include: { model: true },
      }),
      this.prisma.modelRequestPricing.count({ where }),
    ]);

    return {
      data: pricings.map((p) => this.mapPricingToResponse(p)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async updateModelPricing(
    id: string,
    dto: Partial<CreateModelPricingDto>,
  ): Promise<ModelPricingResponse> {
    const existing = await this.prisma.modelRequestPricing.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Pricing with id "${id}" not found`);
    }

    const pricing = await this.prisma.modelRequestPricing.update({
      where: { id },
      data: {
        inputPricePer1M: dto.inputPricePer1M,
        outputPricePer1M: dto.outputPricePer1M,
        originalInputPrice: dto.originalInputPrice,
        originalOutputPrice: dto.originalOutputPrice,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: dto.effectiveTo,
      },
      include: { model: true },
    });

    return this.mapPricingToResponse(pricing);
  }

  // ==================== USER MANAGEMENT ====================

  async getUsers(
    params: PaginationQuery & { isActive?: boolean },
  ): Promise<PaginatedResponse<AdminUserResponse>> {
    const {
      page = 1,
      limit = 20,
      search,
      isActive,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (isActive !== undefined) where.isActive = isActive;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          subscription: {
            include: { plan: true },
          },
          walletBalance: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        isActive: u.isActive,
        isSuperAdmin: u.isSuperAdmin,
        stripeCustomerId: u.stripeCustomerId,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        subscription: u.subscription
          ? {
            id: u.subscription.id,
            planId: u.subscription.planId,
            planName: u.subscription.plan.name,
            status: u.subscription.status,
            currentPeriodEnd: u.subscription.currentPeriodEnd,
          }
          : null,
        walletBalance: u.walletBalance?.balanceCents.toString() || '0',
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUser(id: string): Promise<AdminUserResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        subscription: {
          include: { plan: true },
        },
        walletBalance: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with id "${id}" not found`);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin,
      stripeCustomerId: user.stripeCustomerId,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      subscription: user.subscription
        ? {
          id: user.subscription.id,
          planId: user.subscription.planId,
          planName: user.subscription.plan.name,
          status: user.subscription.status,
          currentPeriodEnd: user.subscription.currentPeriodEnd,
        }
        : null,
      walletBalance: user.walletBalance?.balanceCents.toString() || '0',
    };
  }

  async updateUser(id: string, dto: UpdateUserDto): Promise<AdminUserResponse> {
    const existing = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`User with id "${id}" not found`);
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        isActive: dto.isActive,
        isSuperAdmin: dto.isSuperAdmin,
      },
    });

    // Invalidate user's policy cache
    await this.invalidateUserPolicyCache(id);

    return this.getUser(id);
  }

  async adjustUserWallet(
    userId: string,
    dto: WalletAdjustmentDto,
    adminId: string,
  ): Promise<AdminUserResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { walletBalance: true },
    });

    if (!user) {
      throw new NotFoundException(`User with id "${userId}" not found`);
    }

    const amountCents = BigInt(dto.amountCents);
    const txType = dto.txType || WalletTxType.ADMIN_ADJUSTMENT;

    await this.prisma.$transaction(async (tx) => {
      // Ensure wallet exists
      if (!user.walletBalance) {
        await tx.walletBalance.create({
          data: {
            userId,
            balanceCents: BigInt(0),
          },
        });
      }

      // Update balance
      const currentBalance = user.walletBalance?.balanceCents || BigInt(0);
      const newBalance = currentBalance + amountCents;

      if (newBalance < BigInt(0)) {
        throw new BadRequestException(
          'Insufficient balance for this adjustment',
        );
      }

      await tx.walletBalance.update({
        where: { userId },
        data: {
          balanceCents: newBalance,
          totalTopupCents:
            amountCents > BigInt(0) ? { increment: amountCents } : undefined,
        },
      });

      // Create ledger entry
      await tx.walletLedger.create({
        data: {
          userId,
          txType,
          amountCents,
          balanceAfter: newBalance,
          description: dto.reason,
        },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          actorType: 'user',
          action: AuditAction.WALLET_ADJUSTMENT,
          targetType: 'wallet',
          targetId: userId,
          metadata: {
            txType,
            amountCents: dto.amountCents,
            reason: dto.reason,
          },
        },
      });
    });

    // Sync Redis cache
    const newBalance = await this.prisma.walletBalance.findUnique({
      where: { userId },
      select: { balanceCents: true },
    });
    if (newBalance) {
      await this.redis.set(
        `wallet:user:${userId}`,
        newBalance.balanceCents.toString(),
        3600,
      );
    }

    return this.getUser(userId);
  }

  // ==================== ORGANIZATION MANAGEMENT ====================

  async getOrganizations(
    params: PaginationQuery,
  ): Promise<PaginatedResponse<AdminOrgResponse>> {
    const {
      page = 1,
      limit = 20,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.OrganizationWhereInput = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [orgs, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          owner: { select: { email: true } },
          subscription: { include: { plan: true } },
          walletBalance: true,
          _count: { select: { memberships: true } },
        },
      }),
      this.prisma.organization.count({ where }),
    ]);

    return {
      data: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        ownerId: o.ownerId,
        ownerEmail: o.owner.email,
        maxSeats: o.maxSeats,
        isActive: o.isActive,
        stripeCustomerId: o.stripeCustomerId,
        createdAt: o.createdAt,
        memberCount: o._count.memberships,
        subscription: o.subscription
          ? {
            id: o.subscription.id,
            planId: o.subscription.planId,
            planName: o.subscription.plan.name,
            status: o.subscription.status,
            currentPeriodEnd: o.subscription.currentPeriodEnd,
          }
          : null,
        walletBalance: o.walletBalance?.balanceCents.toString() || '0',
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getOrganization(id: string): Promise<AdminOrgResponse> {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        owner: { select: { email: true } },
        subscription: { include: { plan: true } },
        walletBalance: true,
        _count: { select: { memberships: true } },
      },
    });

    if (!org) {
      throw new NotFoundException(`Organization with id "${id}" not found`);
    }

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      ownerId: org.ownerId,
      ownerEmail: org.owner.email,
      maxSeats: org.maxSeats,
      isActive: org.isActive,
      stripeCustomerId: org.stripeCustomerId,
      createdAt: org.createdAt,
      memberCount: org._count.memberships,
      subscription: org.subscription
        ? {
          id: org.subscription.id,
          planId: org.subscription.planId,
          planName: org.subscription.plan.name,
          status: org.subscription.status,
          currentPeriodEnd: org.subscription.currentPeriodEnd,
        }
        : null,
      walletBalance: org.walletBalance?.balanceCents.toString() || '0',
    };
  }

  async updateOrganization(
    id: string,
    dto: UpdateOrgDto,
  ): Promise<AdminOrgResponse> {
    const existing = await this.prisma.organization.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Organization with id "${id}" not found`);
    }

    await this.prisma.organization.update({
      where: { id },
      data: {
        name: dto.name,
        maxSeats: dto.maxSeats,
        isActive: dto.isActive,
      },
    });

    // Invalidate org's policy caches
    await this.invalidateOrgPolicyCaches(id);

    return this.getOrganization(id);
  }

  async adjustOrgWallet(
    orgId: string,
    dto: WalletAdjustmentDto,
    adminId: string,
  ): Promise<AdminOrgResponse> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: { walletBalance: true },
    });

    if (!org) {
      throw new NotFoundException(`Organization with id "${orgId}" not found`);
    }

    const amountCents = BigInt(dto.amountCents);
    const txType = dto.txType || WalletTxType.ADMIN_ADJUSTMENT;

    await this.prisma.$transaction(async (tx) => {
      // Ensure wallet exists
      if (!org.walletBalance) {
        await tx.walletBalance.create({
          data: {
            organizationId: orgId,
            balanceCents: BigInt(0),
          },
        });
      }

      // Update balance
      const currentBalance = org.walletBalance?.balanceCents || BigInt(0);
      const newBalance = currentBalance + amountCents;

      if (newBalance < BigInt(0)) {
        throw new BadRequestException(
          'Insufficient balance for this adjustment',
        );
      }

      await tx.walletBalance.update({
        where: { organizationId: orgId },
        data: {
          balanceCents: newBalance,
          totalTopupCents:
            amountCents > BigInt(0) ? { increment: amountCents } : undefined,
        },
      });

      // Create ledger entry
      await tx.walletLedger.create({
        data: {
          organizationId: orgId,
          txType,
          amountCents,
          balanceAfter: newBalance,
          description: dto.reason,
        },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          actorType: 'user',
          action: AuditAction.WALLET_ADJUSTMENT,
          targetType: 'wallet',
          targetId: orgId,
          metadata: {
            txType,
            amountCents: dto.amountCents,
            reason: dto.reason,
          },
        },
      });
    });

    // Sync Redis cache
    const newBalance = await this.prisma.walletBalance.findUnique({
      where: { organizationId: orgId },
      select: { balanceCents: true },
    });
    if (newBalance) {
      await this.redis.set(
        `wallet:org:${orgId}`,
        newBalance.balanceCents.toString(),
        3600,
      );
    }

    return this.getOrganization(orgId);
  }

  // ==================== API KEY MANAGEMENT ====================

  async getApiKeys(
    params: PaginationQuery & {
      ownerId?: string;
      ownerType?: string;
      isActive?: boolean;
    },
  ): Promise<PaginatedResponse<AdminApiKeyResponse>> {
    const {
      page = 1,
      limit = 50,
      search,
      ownerId,
      ownerType,
      isActive,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.ApiKeyWhereInput = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { keyPrefix: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (ownerId) {
      if (ownerType === 'USER') {
        where.userId = ownerId;
      } else if (ownerType === 'PROJECT') {
        where.projectId = ownerId;
      }
    }
    if (ownerType) where.ownerType = ownerType as ApiKeyOwnerType;
    if (isActive !== undefined) where.isActive = isActive;

    const [keys, total] = await Promise.all([
      this.prisma.apiKey.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.apiKey.count({ where }),
    ]);

    return {
      data: keys.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        name: k.name,
        ownerType: k.ownerType,
        userId: k.userId,
        projectId: k.projectId,
        isActive: k.isActive,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
        usageCount: k.usageCount.toString(),
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async revokeApiKey(
    id: string,
    adminId: string,
    reason?: string,
  ): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id },
    });

    if (!key) {
      throw new NotFoundException(`API key with id "${id}" not found`);
    }

    if (!key.isActive || key.revokedAt) {
      throw new ConflictException('API key is already revoked');
    }

    await this.prisma.$transaction([
      this.prisma.apiKey.update({
        where: { id },
        data: {
          isActive: false,
          revokedAt: new Date(),
          revokedReason: reason || 'Revoked by admin',
        },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: adminId,
          actorType: 'user',
          action: AuditAction.API_KEY_REVOKED,
          targetType: 'api_key',
          targetId: id,
          metadata: { keyPrefix: key.keyPrefix, reason },
        },
      }),
    ]);

    // Remove from Redis cache
    await this.redis.del(`apikey:${key.keyHash}`);
  }

  // ==================== TOPUP PACKAGES ====================

  async createTopupPackage(
    dto: CreateTopupPackageDto,
  ): Promise<TopupPackageResponse> {
    const pkg = await this.prisma.topupPackage.create({
      data: {
        name: dto.name,
        description: dto.description,
        amountCents: dto.amountCents,
        creditCents: dto.creditCents,
        stripePriceId: dto.stripePriceId,
        isActive: dto.isActive ?? true,
        isPopular: dto.isPopular ?? false,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    return this.mapTopupPackageToResponse(pkg);
  }

  async getTopupPackages(
    params: PaginationQuery,
  ): Promise<PaginatedResponse<TopupPackageResponse>> {
    const { page = 1, limit = 20 } = params;
    const skip = (page - 1) * limit;

    const [packages, total] = await Promise.all([
      this.prisma.topupPackage.findMany({
        skip,
        take: limit,
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.topupPackage.count(),
    ]);

    return {
      data: packages.map((p) => this.mapTopupPackageToResponse(p)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async updateTopupPackage(
    id: string,
    dto: UpdateTopupPackageDto,
  ): Promise<TopupPackageResponse> {
    const existing = await this.prisma.topupPackage.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Topup package with id "${id}" not found`);
    }

    const pkg = await this.prisma.topupPackage.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        amountCents: dto.amountCents,
        creditCents: dto.creditCents,
        stripePriceId: dto.stripePriceId,
        isActive: dto.isActive,
        isPopular: dto.isPopular,
        sortOrder: dto.sortOrder,
      },
    });

    return this.mapTopupPackageToResponse(pkg);
  }

  async deleteTopupPackage(id: string): Promise<void> {
    const existing = await this.prisma.topupPackage.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Topup package with id "${id}" not found`);
    }

    await this.prisma.topupPackage.delete({
      where: { id },
    });
  }

  // ==================== USAGE & ANALYTICS ====================

  async getUsageOverview(params: {
    startDate?: Date;
    endDate?: Date;
    ownerId?: string;
    ownerType?: ApiKeyOwnerType;
  }): Promise<UsageOverviewResponse> {
    const startDate =
      params.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = params.endDate || new Date();

    const where: Prisma.RequestEventWhereInput = {
      createdAt: { gte: startDate, lte: endDate },
    };
    if (params.ownerId) where.ownerId = params.ownerId;
    if (params.ownerType) where.ownerType = params.ownerType;

    const [stats, byModel] = await Promise.all([
      this.prisma.requestEvent.aggregate({
        where,
        _count: true,
        _sum: {
          inputTokens: true,
          outputTokens: true,
          costCents: true,
        },
      }),
      this.prisma.requestEvent.groupBy({
        by: ['model'],
        where,
        _count: true,
        _sum: {
          inputTokens: true,
          outputTokens: true,
        },
        orderBy: { _count: { model: 'desc' } },
        take: 10,
      }),
    ]);

    const successCount = await this.prisma.requestEvent.count({
      where: { ...where, status: 'SUCCESS' },
    });

    return {
      totalRequests: stats._count,
      totalSuccessful: successCount,
      totalErrors: stats._count - successCount,
      totalInputTokens: (stats._sum.inputTokens || 0).toString(),
      totalOutputTokens: (stats._sum.outputTokens || 0).toString(),
      totalCostCents: (stats._sum.costCents || 0).toString(),
      period: {
        start: startDate,
        end: endDate,
      },
      byModel: byModel.map((m) => ({
        model: m.model,
        requestCount: m._count,
        inputTokens: (m._sum.inputTokens || 0).toString(),
        outputTokens: (m._sum.outputTokens || 0).toString(),
      })),
    };
  }

  async getAuditLogs(
    params: PaginationQuery & {
      actorId?: string;
      action?: string;
      targetType?: string;
    },
  ): Promise<PaginatedResponse<AuditLogResponse>> {
    const {
      page = 1,
      limit = 50,
      actorId,
      action,
      targetType,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {};
    if (actorId) where.actorId = actorId;
    if (action) where.action = action as AuditAction;
    if (targetType) where.targetType = targetType;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: logs.map((l) => ({
        id: l.id,
        actorId: l.actorId,
        actorType: l.actorType,
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        metadata: l.metadata as Record<string, unknown> | null,
        ipAddress: l.ipAddress,
        createdAt: l.createdAt,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ==================== HELPERS ====================

  private mapPlanToResponse(plan: any): PlanResponse {
    return {
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      description: plan.description,
      stripePriceId: plan.stripePriceId,
      stripeProductId: plan.stripeProductId,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
      limitPerMinute: plan.limitPerMinute,
      limitPerHour: plan.limitPerHour,
      limitPerDay: plan.limitPerDay,
      dailyAllowance: plan.dailyAllowance,
      maxConcurrent: plan.maxConcurrent,
      maxInputTokens: plan.maxInputTokens,
      maxOutputTokens: plan.maxOutputTokens,
      maxBodyBytes: plan.maxBodyBytes,
      maxSeats: plan.maxSeats,
      pricePerSeat: plan.pricePerSeat,
      allowedModels: plan.allowedModels as string[],
      isActive: plan.isActive,
      isPublic: plan.isPublic,
      isFree: plan.isFree,
      hasWalletAccess: plan.hasWalletAccess,
      hasStreaming: plan.hasStreaming,
      hasPriorityQueue: plan.hasPriorityQueue,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  private mapModelToResponse(model: any): ModelResponse {
    return {
      id: model.id,
      modelId: model.modelId,
      provider: model.provider,
      displayName: model.displayName,
      description: model.description,
      upstreamModelId: model.upstreamModelId,
      supportsStreaming: model.supportsStreaming,
      supportsVision: model.supportsVision,
      supportsToolCalls: model.supportsToolCalls,
      supportsFunctionCall: model.supportsFunctionCall,
      supportsJson: model.supportsJson,
      maxContextTokens: model.maxContextTokens,
      maxOutputTokens: model.maxOutputTokens,
      isActive: model.isActive,
      isDeprecated: model.isDeprecated,
      sortOrder: model.sortOrder,
      category: model.category,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    };
  }

  private mapPricingToResponse(pricing: any): ModelPricingResponse {
    return {
      id: pricing.id,
      modelId: pricing.model?.modelId || pricing.modelId,
      inputPricePer1M: pricing.inputPricePer1M,
      outputPricePer1M: pricing.outputPricePer1M,
      originalInputPrice: pricing.originalInputPrice,
      originalOutputPrice: pricing.originalOutputPrice,
      effectiveFrom: pricing.effectiveFrom,
      effectiveTo: pricing.effectiveTo,
      createdAt: pricing.createdAt,
    };
  }

  private mapTopupPackageToResponse(pkg: any): TopupPackageResponse {
    return {
      id: pkg.id,
      name: pkg.name,
      description: pkg.description,
      amountCents: pkg.amountCents,
      creditCents: pkg.creditCents,
      stripePriceId: pkg.stripePriceId,
      isActive: pkg.isActive,
      isPopular: pkg.isPopular,
      sortOrder: pkg.sortOrder,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
    };
  }

  private async invalidatePlanPolicyCaches(planId: string): Promise<void> {
    // Find all subscriptions using this plan and invalidate their caches
    const subscriptions = await this.prisma.subscription.findMany({
      where: { planId },
      select: { userId: true, organizationId: true },
    });

    const keys: string[] = [];
    for (const sub of subscriptions) {
      if (sub.userId) {
        keys.push(`policy:USER:${sub.userId}`);
      }
      if (sub.organizationId) {
        keys.push(`policy:PROJECT:${sub.organizationId}`);
      }
    }

    if (keys.length > 0) {
      await Promise.all(keys.map((k) => this.redis.del(k)));
    }
  }

  private async invalidateUserPolicyCache(userId: string): Promise<void> {
    await this.redis.del(`policy:USER:${userId}`);
  }

  private async invalidateOrgPolicyCaches(orgId: string): Promise<void> {
    // Invalidate all projects under this org
    const projects = await this.prisma.project.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    });

    const keys = projects.map((p) => `policy:PROJECT:${p.id}`);
    if (keys.length > 0) {
      await Promise.all(keys.map((k) => this.redis.del(k)));
    }
  }
}
