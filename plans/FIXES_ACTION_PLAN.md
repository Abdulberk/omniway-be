# 🔧 Implementation Action Plan - Critical Fixes

**Created:** 2026-02-23  
**Status:** Ready for Implementation  
**Estimated Effort:** 6-8 sprints

---

## 🚨 Phase 1: CRITICAL Fixes (Must Complete Before Production)

### Fix #1: Redis-Database Consistency (Saga Pattern)

**File:** `src/modules/billing/billing.service.ts`
**Lines:** 117-138
**Severity:** CRITICAL

**Problem:**
Billing Lua script updates Redis first, then database writes. If DB fails, rollback happens but if rollback also fails, money is lost.

**Solution Steps:**
1. Create `BillingSagaService` to manage distributed transactions
2. Implement compensating transaction pattern
3. Add persistent transaction log in PostgreSQL
4. Create reconciliation job that runs every 5 minutes

**New Files to Create:**
```
src/modules/billing/billing-saga.service.ts
src/modules/billing/saga-transaction.entity.ts (in Prisma schema)
src/modules/billing/reconciliation.service.ts
src/modules/billing/reconciliation.processor.ts (BullMQ worker)
```

**Prisma Schema Addition:**
```prisma
model BillingTransaction {
  id            String   @id @default(cuid())
  requestId     String   @unique
  ownerType     String
  ownerId       String
  amountCents   BigInt
  status        String   // PENDING, COMMITTED, ROLLED_BACK
  redisState    Json     // Store Redis state for recovery
  dbState       Json     // Store DB state for recovery
  retryCount    Int      @default(0)
  completedAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([status, createdAt])
  @@index([ownerType, ownerId])
}
```

**Implementation:**
```typescript
// billing-saga.service.ts
export class BillingSagaService {
  async chargeWithSaga(params: ChargeParams): Promise<BillingResult> {
    const sagaId = crypto.randomUUID();

    // Step 1: Log transaction start
    await this.createTransactionLog(sagaId, params);

    try {
      // Step 2: Execute Redis operation (idempotent)
      const redisResult = await this.executeRedisCharge(params);

      // Step 3: Execute DB operation (idempotent)
      await this.executeDbCharge(params, redisResult);

      // Step 4: Mark as committed
      await this.markCommitted(sagaId);

      return redisResult;
    } catch (error) {
      // Step 5: Compensating transaction
      await this.rollback(sagaId, params);
      throw error;
    }
  }

  private async rollback(sagaId: string, params: ChargeParams): Promise<void> {
    // Compensate Redis
    await this.walletService.rollbackRedis(...);
    // Log rollback
    await this.markRolledBack(sagaId);
  }
}
```

---

### Fix #2: Remove In-Memory Event Buffer

**File:** `src/modules/usage/usage.service.ts`
**Lines:** 21-24
**Severity:** CRITICAL

**Problem:**
Events buffered in memory are lost on application crash, causing billing data loss.

**Solution Steps:**
1. Remove in-memory buffer
2. Send events directly to BullMQ queue
3. Let BullMQ handle batching internally

**Changes Required:**

**Before:**
```typescript
// usage.service.ts
private eventBuffer: RequestCompletedEvent[] = [];
private readonly BATCH_SIZE = 100;

async emitRequestCompleted(event: RequestCompletedEvent): Promise<void> {
  this.eventBuffer.push(event);
  if (this.eventBuffer.length >= this.BATCH_SIZE) {
    await this.flushBuffer();
  }
}
```

**After:**
```typescript
async emitRequestCompleted(event: RequestCompletedEvent): Promise<void> {
  try {
    await this.eventsQueue.add(
      USAGE_JOBS.SINGLE_EVENT,  // New job type
      event,
      {
        attempts: 5,  // More retries for critical events
        backoff: { type: 'exponential', delay: 1000 },
      }
    );
  } catch (error) {
    // Fallback to local file if queue is down
    await this.fallbackToFile(event);
    throw error;
  }
}
```

**Add Fallback Mechanism:**
```typescript
private async fallbackToFile(event: RequestCompletedEvent): Promise<void> {
  const logPath = `/tmp/events-fallback-${Date.now()}.log`;
  await fs.appendFile(logPath, JSON.stringify(event) + '\n');
  // Recovery job will read these files later
}
```

---

### Fix #3: Add Rate Limiting to Admin Endpoints

**File:** `src/modules/admin/admin.controller.ts`
**Severity:** CRITICAL

**Problem:**
Admin endpoints lack rate limiting, vulnerable to brute force and DoS.

**Solution Steps:**
1. Create `AdminRateLimitGuard`
2. Apply to all admin routes
3. Configure strict limits for destructive operations

**New File:**
```typescript
// src/modules/admin/guards/admin-rate-limit.guard.ts
@Injectable()
export class AdminRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimitService: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const adminId = request.adminUser?.id;

    // Stricter limits for admin
    const result = await this.rateLimitService.checkAdminRateLimit(adminId);

    if (!result.allowed) {
      throw new ThrottlerException(result.reason);
    }

    return true;
  }
}
```

**Update Controller:**
```typescript
@Controller('admin')
@UseGuards(AdminGuard, AdminRateLimitGuard)  // ✅ Add rate limit guard
export class AdminController {
  @Post('plans')
  @UseGuards(AdminDestructiveGuard)  // Extra guard for destructive ops
  async createPlan(@Body() dto: CreatePlanDto) { }
}
```

---

### Fix #4: Fix Admin Authentication

**File:** `src/modules/admin/admin.controller.ts`
**Lines:** 169-177
**Severity:** CRITICAL

**Problem:**
Admin ID comes from query parameter, falls back to 'system', bypassing audit.

**Solution:**
```typescript
// Before (BAD)
@Post('users/:id/wallet-adjustment')
async adjustUserWallet(
  @Param('id') id: string,
  @Body() dto: WalletAdjustmentDto,
  @Query('_req') req: AdminRequest,
) {
  const adminId = req?.adminUser?.id || 'system';  // ❌
}

// After (GOOD)
@Post('users/:id/wallet-adjustment')
async adjustUserWallet(
  @Param('id') id: string,
  @Body() dto: WalletAdjustmentDto,
  @Req() req: Request & { adminUser: AdminUser },
) {
  if (!req.adminUser?.id) {
    throw new UnauthorizedException('Admin authentication required');
  }

  // Validate admin has permission
  const permission = await this.adminService.checkPermission(
    req.adminUser.id,
    'wallet:adjust',
  );
  if (!permission) {
    throw new ForbiddenException('Insufficient permissions');
  }

  // Validate amount based on admin tier
  const maxAdjustment = this.getMaxAdjustmentForAdmin(req.adminUser.role);
  if (Math.abs(dto.amountCents) > maxAdjustment) {
    throw new BadRequestException('Amount exceeds authorized limit');
  }

  return this.adminService.adjustWallet(id, dto, req.adminUser.id);
}
```

---

### Fix #5: Add Database Indexes

**File:** `prisma/schema.prisma`
**Severity:** CRITICAL

**Problem:**
Missing indexes cause slow queries at scale.

**Solution - Add Migration:**

```prisma
// RequestEvent indexes
model RequestEvent {
  // ... existing fields ...

  @@index([createdAt])                    // NEW: Time-range queries
  @@index([ownerType, ownerId, createdAt]) // NEW: User analytics
  @@index([model, createdAt])              // NEW: Model analytics
  @@index([status, createdAt])             // NEW: Error tracking
  @@index([apiKeyId, createdAt])           // NEW: API key analytics
}

// WalletLedger indexes
model WalletLedger {
  // ... existing fields ...

  @@index([userId, createdAt])             // NEW: User ledger queries
  @@index([organizationId, createdAt])     // NEW: Org ledger queries
  @@index([createdAt])                     // NEW: Time-based queries
}

// ApiKey indexes
model ApiKey {
  // ... existing fields ...

  @@index([lastUsedAt])                    // NEW: Usage tracking
  @@index([ownerType, ownerId, isActive])  // NEW: Active key lookup
}

// AuditLog indexes
model AuditLog {
  // ... existing fields ...

  @@index([actorType, actorId, createdAt]) // NEW: Audit queries
  @@index([createdAt])                     // NEW: Recent audits
}
```

**Create Migration:**
```bash
npx prisma migrate dev --name add_performance_indexes
```

---

### Fix #6: Implement BigInt JSON Serialization

**File:** `src/main.ts`
**Severity:** CRITICAL

**Problem:**
BigInt values can't be serialized to JSON, causing API failures.

**Solution:**

```typescript
// Add to main.ts, before bootstrap()
BigInt.prototype.toJSON = function() {
  return this.toString();
};

// Also add to Fastify serializer
const fastifyAdapter = new FastifyAdapter({
  serializerCompiler: ({ schema }) => {
    return (data) => JSON.stringify(data, (_key, value) => {
      return typeof value === 'bigint' ? value.toString() : value;
    });
  },
  // ... existing config
});
```

**Also update response DTOs:**
```typescript
export class WalletBalanceResponse {
  balanceCents: string;  // ✅ String, not bigint
  totalSpentCents: string;
}
```

---

## 🟠 Phase 2: HIGH Priority Fixes

### Fix #7: Resolve N+1 Query Problem

**File:** `src/modules/account/account.service.ts`
**Lines:** 577-615

**Solution:**
```typescript
async getUserOrganizations(userId: string) {
  // Use raw query with proper joins
  const result = await this.prisma.$queryRaw`
    SELECT
      o.id,
      o.name,
      o.slug,
      o.logoUrl,
      s.status,
      s.role,
      p.id as planId,
      p.name as planName,
      p.features,
      w.balanceCents,
      w.isLocked,
      COUNT(m.id) as memberCount
    FROM Organization o
    INNER JOIN Membership s ON s.organizationId = o.id
    LEFT JOIN Subscription sub ON sub.organizationId = o.id
    LEFT JOIN Plan p ON p.id = sub.planId
    LEFT JOIN WalletBalance w ON w.organizationId = o.id
    LEFT JOIN Membership m ON m.organizationId = o.id
    WHERE s.userId = ${userId} AND s.status = 'ACTIVE'
    GROUP BY o.id
  `;

  return result.map(this.mapOrganizationRow);
}
```

---

### Fix #8: Fix Memory Leak - Clear Interval

**File:** `src/modules/usage/usage.service.ts`

**Add:**
```typescript
import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';

export class UsageService implements OnModuleInit, OnModuleDestroy {
  // ... existing code ...

  onModuleDestroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Force flush before destroy
    this.forceFlush().catch(err => {
      this.logger.error('Failed to flush on module destroy', err);
    });
  }
}
```

---

### Fix #9: Improve JWT Validation

**File:** `src/modules/auth/auth.service.ts`

**Update:**
```typescript
private verifyAccessToken(token: string): JwtPayload {
  try {
    return this.jwtService.verify(token, {
      issuer: 'omniway-api',
      audience: ['omniway-web', 'omniway-api'],
      clockTolerance: 30, // 30 second tolerance for clock skew
      algorithms: ['HS256'],
    });
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      throw new UnauthorizedException('Token has expired');
    }
    if (error instanceof JsonWebTokenError) {
      throw new UnauthorizedException('Invalid token');
    }
    throw error;
  }
}

// Add token revocation check
async isTokenRevoked(jti: string): Promise<boolean> {
  const revoked = await this.redis.getClient().get(`revoked:${jti}`);
  return !!revoked;
}
```

---

### Fix #10: Fix Redis URL Configuration

**File:** `src/app.module.ts`

**Solution:**
```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (configService: ConfigService) => {
    // Try REDIS_URL first, fall back to individual params
    const redisUrl = configService.get<string>('REDIS_URL');
    
    if (redisUrl) {
      // Parse REDIS_URL
      const url = new URL(redisUrl);
      return {
        connection: {
          host: url.hostname,
          port: parseInt(url.port) || 6379,
          password: url.password || undefined,
          db: url.pathname.slice(1) ? parseInt(url.pathname.slice(1)) : 0,
        },
      };
    }
    
    // Fall back to individual config
    return {
      connection: {
        host: configService.get<string>('REDIS_HOST', 'localhost'),
        port: configService.get<number>('REDIS_PORT', 6379),
        password: configService.get<string>('REDIS_PASSWORD'),
        db: configService.get<number>('REDIS_DB', 0),
      },
    };
  },
  inject: [ConfigService],
}),
```

---

### Fix #11: Generic Webhook Error Messages

**File:** `src/modules/stripe/stripe-webhook.controller.ts`

**Update:**
```typescript
try {
  event = this.stripeService.constructWebhookEvent(rawBody, signature);
} catch (err) {
  // Log actual error for debugging
  this.logger.warn('Webhook signature verification failed', {
    error: err.message,
    ip: req.ip,
    timestamp: new Date().toISOString(),
  });
  // Return generic message to client
  throw new BadRequestException('Invalid webhook signature');
}
```

---

### Fix #12: Strengthen API Key Prefix

**File:** `src/modules/auth/api-key.service.ts`

**Update:**
```typescript
generateApiKey(): { key: string; prefix: string; hash: string } {
  // Generate 48 random bytes for better entropy
  const randomBytes = crypto.randomBytes(48);
  const keyPlain = `omni_${randomBytes.toString('base64url')}`;

  // Use first 20 characters as prefix (was 12, too short)
  const keyPrefix = keyPlain.substring(0, 20);
  const keyHash = this.hashKey(keyPlain);

  return {
    key: keyPlain,
    prefix: keyPrefix,
    hash: keyHash,
  };
}

// Add timing-safe comparison
async validateApiKey(authHeader: string | undefined): Promise<ValidationResult> {
  // ... existing validation ...

  // Use timing-safe comparison for hash
  const hash = this.hashKey(key);
  const storedHash = Buffer.from(apiKey.keyHash, 'hex');
  const computedHash = Buffer.from(hash, 'hex');

  if (storedHash.length !== computedHash.length ||
      !crypto.timingSafeEqual(storedHash, computedHash)) {
    return {
      isValid: false,
      reason: 'Invalid API key',
    };
  }

  // ... rest of validation ...
}
```

---

## 🟡 Phase 3: MEDIUM Priority Improvements

### Fix #13: Standardize Error Handling

Create base error classes:
```typescript
// src/common/errors/base.error.ts
export abstract class BaseError extends HttpException {
  constructor(
    message: string,
    statusCode: number,
    public readonly errorCode: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(
      {
        error: {
          message,
          type: this.getErrorType(statusCode),
          code: errorCode,
          ...(details && { details }),
        },
      },
      statusCode,
    );
  }

  private getErrorType(status: number): string {
    // Map status codes to error types
  }
}

// Usage
export class InsufficientBalanceError extends BaseError {
  constructor(current: bigint, required: bigint) {
    super(
      `Insufficient balance. Required: ${required}, Available: ${current}`,
      HttpStatus.PAYMENT_REQUIRED,
      'insufficient_balance',
      { current: current.toString(), required: required.toString() },
    );
  }
}
```

---

### Fix #14: Add Query Result Caching

```typescript
// src/common/decorators/cache-response.decorator.ts
export function CacheResponse(ttl: number = 60) {
  return (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cacheKey = `cache:${target.constructor.name}:${propertyKey}:${JSON.stringify(args)}`;
      const redis = this.redisService?.getClient();

      if (redis) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      }

      const result = await originalMethod.apply(this, args);

      if (redis) {
        await redis.setex(cacheKey, ttl, JSON.stringify(result));
      }

      return result;
    };

    return descriptor;
  };
}

// Usage
export class ModelService {
  @CacheResponse(300) // 5 minutes
  async listModels(): Promise<ModelsListResponse> {
    // ...
  }
}
```

---

### Fix #15: Implement Metrics Collection

```typescript
// src/common/metrics/prometheus.service.ts
import { Counter, Histogram, register } from 'prom-client';

export class PrometheusService {
  private requestDuration: Histogram;
  private requestErrors: Counter;

  constructor() {
    this.requestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
    });

    this.requestErrors = new Counter({
      name: 'http_request_errors_total',
      help: 'HTTP request errors',
      labelNames: ['method', 'route', 'error_type'],
    });
  }

  recordRequest(method: string, route: string, status: number, duration: number) {
    this.requestDuration
      .labels(method, route, status)
      .observe(duration / 1000);
  }

  recordError(method: string, route: string, errorType: string) {
    this.requestErrors.labels(method, route, errorType).inc();
  }
}
```

---

### Fix #16: Implement Notification Service

Replace TODO comments with actual implementation:

```typescript
// src/modules/notifications/notifications.service.ts
@Injectable()
export class NotificationsService {
  constructor(
    @InjectQueue('emails') private emailQueue: Queue,
    private prisma: PrismaService,
  ) {}

  async sendPaymentFailed(userId: string, amount: bigint): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });

    await this.emailQueue.add('send-email', {
      to: user.email,
      template: 'payment-failed',
      data: { amount: amount.toString() },
    });
  }

  async sendDisputeNotification(orgId: string, disputeId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: { owners: { select: { user: true } } },
    });

    for (const owner of org.owners) {
      await this.emailQueue.add('send-email', {
        to: owner.user.email,
        template: 'dispute-created',
        data: { disputeId },
      });
    }
  }
}
```

---

### Fix #17: Add Integration Tests

```typescript
// test/integration/billing.flow.spec.ts
describe('Billing Integration Flow', () => {
  it('should complete full billing cycle', async () => {
    // 1. Create user with wallet
    const user = await createTestUser({ walletBalance: 10000 });

    // 2. Make API request
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${user.apiKey}`)
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] })
      .expect(200);

    // 3. Verify wallet was charged
    const wallet = await getWalletBalance(user.id);
    expect(wallet.balanceCents).toBeLessThan(10000n);

    // 4. Verify usage was recorded
    const usage = await getDailyUsage(user.id);
    expect(usage.allowanceUsed).toBeGreaterThan(0);

    // 5. Verify audit log entry
    const audit = await getAuditLog({ userId: user.id });
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'api:request' }),
    );
  });
});
```

---

### Fix #18: Fix CORS Configuration

**File:** `src/config/config.validation.ts`

```typescript
CORS_ORIGINS: Joi.string()
  .pattern(/^https?:\/\/[^,]+(,[^,]+)*$/)
  .required()
  .messages({
    'string.pattern.base': 'CORS_ORIGINS must be comma-separated URLs',
    'any.required': 'CORS_ORIGINS must be specified in production',
  }),
```

**In main.ts:**
```typescript
const corsOrigins = configService.get<string>('CORS_ORIGINS').split(',');

if (process.env.NODE_ENV === 'production' && corsOrigins.includes('*')) {
  logger.warn('⚠️  WARNING: CORS configured to allow all origins in production!');
}
```

---

### Fix #19: Add Distributed Tracing

```typescript
// src/common/tracing/opentelemetry.service.ts
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

export class TracingService {
  static initialize() {
    const provider = new NodeTracerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'omniway-api',
      }),
    });

    const exporter = new JaegerExporter({
      endpoint: process.env.JAEGER_ENDPOINT,
    });

    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    provider.register();
  }
}

// In main.ts
if (process.env.OTEL_ENABLED === 'true') {
  TracingService.initialize();
}
```

---

### Fix #20: Implement Data Retention

```typescript
// src/modules/jobs/data-retention.processor.ts
@Injectable()
export class DataRetentionProcessor {
  private readonly logger = new Logger(DataRetentionProcessor.name);

  // Retention policies (in days)
  private readonly RETENTION = {
    requestEvents: 90,        // 90 days
    walletLedger: 365,        // 1 year
    auditLog: 2555,           // 7 years (compliance)
    usageDaily: 730,          // 2 years
  };

  @Cron('0 2 * * *') // Run at 2 AM daily
  async archiveOldData(): Promise<void> {
    await this.archiveRequestEvents();
    await this.archiveAuditLogs();
    await this.aggregateUsageData();
  }

  private async archiveRequestEvents(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION.requestEvents);

    // Delete in batches to avoid long transactions
    let deleted = 0;
    const batchSize = 10000;

    do {
      deleted = await this.prisma.requestEvent.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
        },
        take: batchSize,
      });

      this.logger.log(`Archived ${deleted} old request events`);
    } while (deleted >= batchSize);
  }
}
```

---

## 📊 Implementation Checklist

### Phase 1 Checklist (Critical)
- [ ] Create BillingSagaService
- [ ] Add BillingTransaction to Prisma schema
- [ ] Implement reconciliation job
- [ ] Remove in-memory event buffer
- [ ] Add AdminRateLimitGuard
- [ ] Apply to all admin routes
- [ ] Fix admin authentication
- [ ] Create database indexes migration
- [ ] Add BigInt JSON serialization
- [ ] Update all BigInt return types

### Phase 2 Checklist (High Priority)
- [ ] Fix N+1 query in account service
- [ ] Add onModuleDestroy to UsageService
- [ ] Improve JWT validation
- [ ] Fix Redis URL configuration
- [ ] Generic webhook error messages
- [ ] Strengthen API key prefix

### Phase 3 Checklist (Medium Priority)
- [ ] Create base error classes
- [ ] Add query result caching
- [ ] Implement metrics service
- [ ] Create notification service
- [ ] Add integration tests
- [ ] Fix CORS configuration
- [ ] Add distributed tracing
- [ ] Implement data retention

---

## 🚀 Quick Start Commands

```bash
# Create migration for indexes
npx prisma migrate dev --name add_performance_indexes

# Generate Prisma client after schema changes
npx prisma generate

# Run tests
npm run test

# Run integration tests
npm run test:e2e

# Build for production
npm run build
```

---

**Next Step:** Review this plan with the team and create tickets for each fix.
