import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiKeyService } from './api-key.service';
import { PolicyService } from './policy.service';
import { AuthContext } from './interfaces/auth.interfaces';
import { ApiKeyOwnerType } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeyService: ApiKeyService,
    private readonly policyService: PolicyService,
  ) { }

  /**
   * Authenticate a request and build the auth context
   */
  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const authHeader = request.headers.authorization;
    const clientIp = this.getClientIp(request);

    // Validate API key
    const validation = await this.apiKeyService.validateApiKey(authHeader);

    if (!validation.isValid || !validation.apiKey) {
      this.logger.warn(`Auth failed: ${validation.reason}`, {
        ip: clientIp,
        keyPrefix: authHeader?.substring(7, 19), // "Bearer " + first 12 chars
      });
      throw new UnauthorizedException(validation.reason || 'Invalid API key');
    }

    const apiKey = validation.apiKey;

    // Check IP allowlist if configured
    if (apiKey.allowedIps.length > 0 && !apiKey.allowedIps.includes(clientIp)) {
      this.logger.warn(`IP not in allowlist: ${clientIp}`, {
        keyPrefix: apiKey.keyPrefix,
      });
      throw new UnauthorizedException('IP address not allowed');
    }

    // Determine owner context
    const { ownerType, ownerId, organizationId, projectId, userId } =
      await this.resolveOwnerContext(apiKey);

    // Get policy for the owner
    const policy = await this.policyService.getPolicy(ownerType, ownerId);

    // Update last used (non-blocking)
    this.apiKeyService.updateLastUsed(apiKey.id, clientIp);

    const authContext: AuthContext = {
      apiKeyId: apiKey.id,
      keyPrefix: apiKey.keyPrefix,
      ownerType,
      ownerId,
      organizationId,
      projectId,
      userId,
      scopes: apiKey.scopes,
      allowedModels: apiKey.allowedModels,
      allowedIps: apiKey.allowedIps,
      policy,
    };

    this.logger.debug(`Authenticated: ${apiKey.keyPrefix}...`, {
      ownerType,
      ownerId,
      planSlug: policy.planSlug,
    });

    return authContext;
  }

  /**
   * Resolve owner context from API key
   */
  private async resolveOwnerContext(
    apiKey: NonNullable<
      Awaited<ReturnType<ApiKeyService['validateApiKey']>>['apiKey']
    >,
  ): Promise<{
    ownerType: ApiKeyOwnerType;
    ownerId: string;
    organizationId?: string;
    projectId?: string;
    userId?: string;
  }> {
    if (apiKey.ownerType === ApiKeyOwnerType.USER) {
      // User key: owner is the user
      return {
        ownerType: ApiKeyOwnerType.USER,
        ownerId: apiKey.userId!,
        userId: apiKey.userId!,
      };
    } else {
      // Project key: owner is the organization
      // Need to fetch project to get the organization
      const project = await this.prisma.project.findUnique({
        where: { id: apiKey.projectId! },
        select: { organizationId: true },
      });

      if (!project) {
        throw new UnauthorizedException('Project not found');
      }

      return {
        ownerType: ApiKeyOwnerType.PROJECT,
        ownerId: project.organizationId, // Billing is at org level
        organizationId: project.organizationId,
        projectId: apiKey.projectId!,
      };
    }
  }

  /**
   * Get client IP from request
   *
   * SECURITY: Only trusts proxy headers when Fastify's trustProxy is configured.
   * When trustProxy is enabled, request.ip already contains the correct client IP
   * from the trusted proxy chain. We use request.ip as the primary source.
   *
   * The X-Forwarded-For header is NOT blindly trusted to prevent IP spoofing
   * attacks that could bypass IP allowlists.
   */
  private getClientIp(request: FastifyRequest): string {
    // Fastify's request.ip respects the trustProxy configuration.
    // When trustProxy is enabled (see main.ts), it reads X-Forwarded-For
    // from the trusted proxy and returns the real client IP.
    // When trustProxy is disabled, it returns the direct connection IP.
    //
    // This is safer than manually parsing X-Forwarded-For because:
    // 1. Fastify validates the proxy chain
    // 2. Prevents IP spoofing via forged X-Forwarded-For headers
    // 3. Only trusts headers from known proxy addresses
    return request.ip;
  }

  /**
   * Check if the auth context has a specific scope
   */
  hasScope(authContext: AuthContext, requiredScope: string): boolean {
    return authContext.scopes.includes(requiredScope);
  }

  /**
   * Check if the auth context can access a specific model
   */
  canAccessModel(authContext: AuthContext, modelId: string): boolean {
    // If no model restrictions on key, check policy
    if (authContext.allowedModels.length === 0) {
      // If no restrictions in policy, allow all
      if (authContext.policy.allowedModels.length === 0) {
        return true;
      }
      return authContext.policy.allowedModels.includes(modelId);
    }

    // Key has model restrictions
    return authContext.allowedModels.includes(modelId);
  }
}
