import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard, AdminRequest } from './guards/admin.guard';
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
  CreateTopupPackageDto,
  UpdateTopupPackageDto,
} from './interfaces/admin.interfaces';

// Query DTOs for validation
interface GetModelsQuery extends PaginationQuery {
  provider?: string;
  category?: string;
}

interface GetUsersQuery extends PaginationQuery {
  isActive?: string; // comes as string from query params
}

interface GetApiKeysQuery extends PaginationQuery {
  ownerId?: string;
  ownerType?: string;
  isActive?: string;
}

interface GetPricingQuery extends PaginationQuery {
  modelId?: string;
}

interface GetAuditLogsQuery extends PaginationQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
}

interface GetUsageQuery {
  startDate?: string;
  endDate?: string;
  ownerId?: string;
  ownerType?: string;
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ==================== PLAN MANAGEMENT ====================

  @Post('plans')
  async createPlan(@Body() dto: CreatePlanDto) {
    return this.adminService.createPlan(dto);
  }

  @Get('plans')
  async getPlans(@Query() query: PaginationQuery) {
    return this.adminService.getPlans(query);
  }

  @Get('plans/:id')
  async getPlan(@Param('id') id: string) {
    return this.adminService.getPlan(id);
  }

  @Patch('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.adminService.updatePlan(id, dto);
  }

  @Delete('plans/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePlan(@Param('id') id: string) {
    await this.adminService.deletePlan(id);
  }

  // ==================== MODEL CATALOG MANAGEMENT ====================

  @Post('models')
  async createModel(@Body() dto: CreateModelDto) {
    return this.adminService.createModel(dto);
  }

  @Get('models')
  async getModels(@Query() query: GetModelsQuery) {
    return this.adminService.getModels(query);
  }

  @Get('models/:id')
  async getModel(@Param('id') id: string) {
    return this.adminService.getModel(id);
  }

  @Patch('models/:id')
  async updateModel(@Param('id') id: string, @Body() dto: UpdateModelDto) {
    return this.adminService.updateModel(id, dto);
  }

  @Delete('models/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteModel(@Param('id') id: string) {
    await this.adminService.deleteModel(id);
  }

  // ==================== MODEL PRICING MANAGEMENT ====================

  @Post('model-pricing')
  async createModelPricing(@Body() dto: CreateModelPricingDto) {
    return this.adminService.createModelPricing(dto);
  }

  @Get('model-pricing')
  async getModelPricing(@Query() query: GetPricingQuery) {
    return this.adminService.getModelPricing(query);
  }

  @Patch('model-pricing/:id')
  async updateModelPricing(
    @Param('id') id: string,
    @Body() dto: Partial<CreateModelPricingDto>,
  ) {
    return this.adminService.updateModelPricing(id, dto);
  }

  // ==================== USER MANAGEMENT ====================

  @Get('users')
  async getUsers(@Query() query: GetUsersQuery) {
    return this.adminService.getUsers({
      ...query,
      isActive: query.isActive === 'true' ? true : query.isActive === 'false' ? false : undefined,
    });
  }

  @Get('users/:id')
  async getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.adminService.updateUser(id, dto);
  }

  @Post('users/:id/wallet-adjustment')
  async adjustUserWallet(
    @Param('id') id: string,
    @Body() dto: WalletAdjustmentDto,
    @Query('_req') req: AdminRequest,
  ) {
    const adminId = req?.adminUser?.id || 'system';
    return this.adminService.adjustUserWallet(id, dto, adminId);
  }

  // ==================== ORGANIZATION MANAGEMENT ====================

  @Get('organizations')
  async getOrganizations(@Query() query: PaginationQuery) {
    return this.adminService.getOrganizations(query);
  }

  @Get('organizations/:id')
  async getOrganization(@Param('id') id: string) {
    return this.adminService.getOrganization(id);
  }

  @Patch('organizations/:id')
  async updateOrganization(@Param('id') id: string, @Body() dto: UpdateOrgDto) {
    return this.adminService.updateOrganization(id, dto);
  }

  @Post('organizations/:id/wallet-adjustment')
  async adjustOrgWallet(
    @Param('id') id: string,
    @Body() dto: WalletAdjustmentDto,
    @Query('_req') req: AdminRequest,
  ) {
    const adminId = req?.adminUser?.id || 'system';
    return this.adminService.adjustOrgWallet(id, dto, adminId);
  }

  // ==================== API KEY MANAGEMENT ====================

  @Get('api-keys')
  async getApiKeys(@Query() query: GetApiKeysQuery) {
    return this.adminService.getApiKeys({
      ...query,
      isActive: query.isActive === 'true' ? true : query.isActive === 'false' ? false : undefined,
    });
  }

  @Delete('api-keys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeApiKey(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Query('_req') req: AdminRequest,
  ) {
    const adminId = req?.adminUser?.id || 'system';
    await this.adminService.revokeApiKey(id, adminId, body.reason);
  }

  // ==================== TOPUP PACKAGES ====================

  @Post('topup-packages')
  async createTopupPackage(@Body() dto: CreateTopupPackageDto) {
    return this.adminService.createTopupPackage(dto);
  }

  @Get('topup-packages')
  async getTopupPackages(@Query() query: PaginationQuery) {
    return this.adminService.getTopupPackages(query);
  }

  @Patch('topup-packages/:id')
  async updateTopupPackage(
    @Param('id') id: string,
    @Body() dto: UpdateTopupPackageDto,
  ) {
    return this.adminService.updateTopupPackage(id, dto);
  }

  @Delete('topup-packages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTopupPackage(@Param('id') id: string) {
    await this.adminService.deleteTopupPackage(id);
  }

  // ==================== USAGE & ANALYTICS ====================

  @Get('usage/overview')
  async getUsageOverview(@Query() query: GetUsageQuery) {
    return this.adminService.getUsageOverview({
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      ownerId: query.ownerId,
      ownerType: query.ownerType as any,
    });
  }

  @Get('audit-logs')
  async getAuditLogs(@Query() query: GetAuditLogsQuery) {
    return this.adminService.getAuditLogs(query);
  }
}