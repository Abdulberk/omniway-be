import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  ApiKeyValidation,
  AUTH_CACHE_KEYS,
  AUTH_CACHE_TTL,
} from './interfaces/auth.interfaces';
import { ApiKeyOwnerType } from '@prisma/client';

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Generate a new API key
   * Format: omni_{random_32_chars}
   */
  generateApiKey(): { key: string; prefix: string; hash: string } {
    const randomPart = randomBytes(24).toString('base64url');
    const key = `omni_${randomPart}`;
    const prefix = key.substring(0, 12); // "omni_" + first 7 chars
    const hash = this.hashKey(key);
    
    return { key, prefix, hash };
  }

  /**
   * Hash an API key for storage
   */
  hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  /**
   * Validate an API key from the Authorization header
   */
  async validateApiKey(authHeader: string | undefined): Promise<ApiKeyValidation> {
    if (!authHeader) {
      return { isValid: false, reason: 'Missing Authorization header' };
    }

    // Extract key from "Bearer <key>" format
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return { isValid: false, reason: 'Invalid Authorization header format' };
    }

    const key = parts[1];
    if (!key.startsWith('omni_')) {
      return { isValid: false, reason: 'Invalid API key format' };
    }

    const keyHash = this.hashKey(key);

    // Check cache first
    const cached = await this.getCachedApiKey(keyHash);
    if (cached) {
      return this.validateCachedKey(cached);
    }

    // Fetch from database
    const apiKey = await this.fetchApiKeyFromDb(keyHash);
    if (!apiKey) {
      return { isValid: false, reason: 'Invalid API key' };
    }

    // Cache the key
    await this.cacheApiKey(keyHash, apiKey);

    return this.validateCachedKey(apiKey);
  }

  /**
   * Get API key from cache
   */
  private async getCachedApiKey(keyHash: string): Promise<ApiKeyValidation['apiKey'] | null> {
    const cacheKey = AUTH_CACHE_KEYS.apiKeyByHash(keyHash);
    const cached = await this.redis.getClient().get(cacheKey);
    
    if (!cached) {
      return null;
    }

    try {
      return JSON.parse(cached);
    } catch {
      return null;
    }
  }

  /**
   * Cache API key data
   */
  private async cacheApiKey(keyHash: string, apiKey: ApiKeyValidation['apiKey']): Promise<void> {
    const cacheKey = AUTH_CACHE_KEYS.apiKeyByHash(keyHash);
    await this.redis.getClient().setex(
      cacheKey,
      AUTH_CACHE_TTL.apiKey,
      JSON.stringify(apiKey),
    );
  }

  /**
   * Fetch API key from database
   */
  private async fetchApiKeyFromDb(keyHash: string): Promise<ApiKeyValidation['apiKey'] | null> {
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        keyPrefix: true,
        ownerType: true,
        userId: true,
        projectId: true,
        scopes: true,
        allowedModels: true,
        allowedIps: true,
        isActive: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!apiKey) {
      return null;
    }

    // Check if revoked
    if (apiKey.revokedAt) {
      return null;
    }

    return {
      id: apiKey.id,
      keyPrefix: apiKey.keyPrefix,
      ownerType: apiKey.ownerType,
      userId: apiKey.userId,
      projectId: apiKey.projectId,
      scopes: apiKey.scopes,
      allowedModels: apiKey.allowedModels,
      allowedIps: apiKey.allowedIps,
      isActive: apiKey.isActive,
      expiresAt: apiKey.expiresAt,
    };
  }

  /**
   * Validate cached key data
   */
  private validateCachedKey(apiKey: ApiKeyValidation['apiKey']): ApiKeyValidation {
    if (!apiKey) {
      return { isValid: false, reason: 'Invalid API key' };
    }

    if (!apiKey.isActive) {
      return { isValid: false, reason: 'API key is inactive' };
    }

    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      return { isValid: false, reason: 'API key has expired' };
    }

    return { isValid: true, apiKey };
  }

  /**
   * Invalidate API key cache (call when key is updated/revoked)
   */
  async invalidateApiKeyCache(keyHash: string): Promise<void> {
    const cacheKey = AUTH_CACHE_KEYS.apiKeyByHash(keyHash);
    await this.redis.getClient().del(cacheKey);
  }

  /**
   * Create a new API key for a user
   */
  async createUserApiKey(
    userId: string,
    name: string,
    scopes: string[] = ['chat:write', 'embeddings:write'],
  ): Promise<{ id: string; key: string; prefix: string }> {
    const { key, prefix, hash } = this.generateApiKey();

    const apiKey = await this.prisma.apiKey.create({
      data: {
        keyPrefix: prefix,
        keyHash: hash,
        name,
        ownerType: ApiKeyOwnerType.USER,
        userId,
        scopes,
      },
    });

    this.logger.log(`Created API key ${prefix}... for user ${userId}`);

    return { id: apiKey.id, key, prefix };
  }

  /**
   * Create a new API key for a project (org)
   */
  async createProjectApiKey(
    projectId: string,
    name: string,
    scopes: string[] = ['chat:write', 'embeddings:write'],
  ): Promise<{ id: string; key: string; prefix: string }> {
    const { key, prefix, hash } = this.generateApiKey();

    const apiKey = await this.prisma.apiKey.create({
      data: {
        keyPrefix: prefix,
        keyHash: hash,
        name,
        ownerType: ApiKeyOwnerType.PROJECT,
        projectId,
        scopes,
      },
    });

    this.logger.log(`Created API key ${prefix}... for project ${projectId}`);

    return { id: apiKey.id, key, prefix };
  }

  /**
   * Revoke an API key
   */
  async revokeApiKey(keyId: string, reason?: string): Promise<void> {
    const apiKey = await this.prisma.apiKey.update({
      where: { id: keyId },
      data: {
        isActive: false,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });

    // Invalidate cache
    await this.invalidateApiKeyCache(apiKey.keyHash);

    this.logger.log(`Revoked API key ${apiKey.keyPrefix}... (${keyId})`);
  }

  /**
   * Update last used info
   */
  async updateLastUsed(keyId: string, ip: string): Promise<void> {
    // Use a non-blocking update
    this.prisma.apiKey
      .update({
        where: { id: keyId },
        data: {
          lastUsedAt: new Date(),
          lastUsedIp: ip,
          usageCount: { increment: 1 },
        },
      })
      .catch((err) => {
        this.logger.error(`Failed to update last used for key ${keyId}`, err);
      });
  }
}