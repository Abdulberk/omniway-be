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
  Req,
} from '@nestjs/common';
import { AccountService } from './account.service';
import { UserGuard, UserRequest } from './guards/user.guard';
import {
  UpdateProfileDto,
  CreateApiKeyDto,
  UsageHistoryQuery,
  WalletLedgerQuery,
  CreateOrganizationDto,
  InviteMemberDto,
  UpdateMemberRoleDto,
  CreateProjectDto,
  UpdateNotificationPreferencesDto,
} from './interfaces/account.interfaces';

@Controller('me')
@UseGuards(UserGuard)
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  // ==================== PROFILE ====================

  @Get()
  async getProfile(@Req() req: UserRequest) {
    return this.accountService.getProfile(req.user!.id);
  }

  @Patch()
  async updateProfile(@Req() req: UserRequest, @Body() dto: UpdateProfileDto) {
    return this.accountService.updateProfile(req.user!.id, dto);
  }

  // ==================== API KEYS ====================

  @Get('api-keys')
  async getApiKeys(@Req() req: UserRequest) {
    return this.accountService.getUserApiKeys(req.user!.id);
  }

  @Post('api-keys')
  async createApiKey(@Req() req: UserRequest, @Body() dto: CreateApiKeyDto) {
    return this.accountService.createUserApiKey(req.user!.id, dto);
  }

  @Delete('api-keys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeApiKey(@Req() req: UserRequest, @Param('id') id: string) {
    await this.accountService.revokeUserApiKey(req.user!.id, id);
  }

  // ==================== USAGE ====================

  @Get('usage')
  async getUsageSummary(
    @Req() req: UserRequest,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.accountService.getUsageSummary(
      req.user!.id,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }

  @Get('usage/history')
  async getRequestHistory(@Req() req: UserRequest, @Query() query: UsageHistoryQuery) {
    return this.accountService.getRequestHistory(req.user!.id, query);
  }

  // ==================== WALLET ====================

  @Get('wallet')
  async getWallet(@Req() req: UserRequest) {
    return this.accountService.getWallet(req.user!.id);
  }

  @Get('wallet/ledger')
  async getWalletLedger(@Req() req: UserRequest, @Query() query: WalletLedgerQuery) {
    return this.accountService.getWalletLedger(req.user!.id, query);
  }

  // ==================== BILLING ====================

  @Get('billing')
  async getBillingOverview(@Req() req: UserRequest) {
    return this.accountService.getBillingOverview(req.user!.id);
  }

  // ==================== ORGANIZATIONS ====================

  @Get('organizations')
  async getOrganizations(@Req() req: UserRequest) {
    return this.accountService.getUserOrganizations(req.user!.id);
  }

  @Post('organizations')
  async createOrganization(@Req() req: UserRequest, @Body() dto: CreateOrganizationDto) {
    return this.accountService.createOrganization(req.user!.id, dto);
  }

  @Get('organizations/:orgId/members')
  async getOrganizationMembers(@Req() req: UserRequest, @Param('orgId') orgId: string) {
    return this.accountService.getOrganizationMembers(req.user!.id, orgId);
  }

  @Post('organizations/:orgId/invitations')
  async inviteMember(
    @Req() req: UserRequest,
    @Param('orgId') orgId: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.accountService.inviteMember(req.user!.id, orgId, dto);
  }

  @Patch('organizations/:orgId/members/:userId')
  async updateMemberRole(
    @Req() req: UserRequest,
    @Param('orgId') orgId: string,
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    await this.accountService.updateMemberRole(req.user!.id, orgId, targetUserId, dto);
    return { success: true };
  }

  @Delete('organizations/:orgId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Req() req: UserRequest,
    @Param('orgId') orgId: string,
    @Param('userId') targetUserId: string,
  ) {
    await this.accountService.removeMember(req.user!.id, orgId, targetUserId);
  }

  // ==================== PROJECTS ====================

  @Get('organizations/:orgId/projects')
  async getProjects(@Req() req: UserRequest, @Param('orgId') orgId: string) {
    return this.accountService.getOrgProjects(req.user!.id, orgId);
  }

  @Post('organizations/:orgId/projects')
  async createProject(
    @Req() req: UserRequest,
    @Param('orgId') orgId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.accountService.createProject(req.user!.id, orgId, dto);
  }

  // ==================== NOTIFICATION PREFERENCES ====================

  @Get('notifications')
  async getNotificationPreferences(@Req() req: UserRequest) {
    return this.accountService.getNotificationPreferences(req.user!.id);
  }

  @Patch('notifications')
  async updateNotificationPreferences(
    @Req() req: UserRequest,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.accountService.updateNotificationPreferences(req.user!.id, dto);
  }
}