# 🔒 Security Fixes Implementation Plan

**Created:** 2026-02-23  
**Status:** Ready for Implementation  
**Priority:** CRITICAL - Production Blocker

---

## 📊 Executive Summary

Bu plan, [`CRITICAL_SECURITY_AUDIT.md`](CRITICAL_SECURITY_AUDIT.md) raporunda tespit edilen **Priority 1-3** güvenlik açıklarını çözmek için hazırlanmıştır.

**Kapsam:**
- ✅ 9 Critical Vulnerability (Severity 9-10)
- ✅ 5 High Vulnerability (Severity 7-8)
- ✅ **Toplam 14 güvenlik açığı**

**Etkilenen Sistemler:**
- Authentication & Authorization
- Admin Panel
- User Account Management
- API Key System
- CORS & Network Security
- Webhook Processing

---

## 🎯 Implementation Goals

### Primary Goals (Must Have - Production Blockers)
1. ✅ JWT-based authentication için Admin & User guard'ları yeniden yaz
2. ✅ Admin controller'daki query parameter authentication'ı kaldır
3. ✅ Admin & Account endpoints'lere rate limiting ekle

### Secondary Goals (Should Have - High Priority)
4. ✅ API Key timing-safe comparison
5. ✅ IP allowlist bypass protection
6. ✅ CORS configuration hardening
7. ✅ Webhook error message sanitization

---

## 📋 Detailed Implementation Plan

### **Phase 1: JWT Authentication Infrastructure** 🔴 CRITICAL

#### 1.1. JWT Service Oluştur

**Yeni Dosya:** `src/modules/auth/jwt.service.ts`

**Sorumluluklar:**
- JWT token generation (sign)
- JWT token verification
- Token expiration handling
- Refresh token logic (optional)

**Implementation:**

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface JwtPayload {
  sub: string; // user ID
  email: string;
  isSuperAdmin?: boolean;
  iat: number; // issued at
  exp: number; // expiration
  iss: string; // issuer
  aud: string; // audience
}

@Injectable()
export class JwtService {
  private readonly secret: string;
  private readonly expiresIn: string;
  private readonly issuer = 'omniway-api';
  private readonly audience = 'omniway-clients';

  constructor(private readonly config: ConfigService) {
    this.secret = this.config.get<string>('JWT_SECRET')!;
    this.expiresIn = this.config.get<string>('JWT_EXPIRES_IN', '7d');
  }

  /**
   * Generate JWT token for a user
   */
  sign(payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud'>): string {
    const now = Math.floor(Date.now() / 1000);
    const expiresInSeconds = this.parseExpiration(this.expiresIn);
    
    const fullPayload: JwtPayload = {
      ...payload,
      iat: now,
      exp: now + expiresInSeconds,
      iss: this.issuer,
      aud: this.audience,
    };

    // Create header
    const header = {
      alg: 'HS256',
      typ: 'JWT',
    };

    // Encode
    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(fullPayload));
    const data = `${encodedHeader}.${encodedPayload}`;

    // Sign
    const signature = createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');

    return `${data}.${signature}`;
  }

  /**
   * Verify and decode JWT token
   */
  verify(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid token format');
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const data = `${encodedHeader}.${encodedPayload}`;

    // Verify signature (timing-safe)
    const expectedSignature = createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');

    if (!this.timingSafeCompare(signature, expectedSignature)) {
      throw new UnauthorizedException('Invalid token signature');
    }

    // Decode payload
    let payload: JwtPayload;
    try {
      const payloadJson = Buffer.from(encodedPayload, 'base64url').toString();
      payload = JSON.parse(payloadJson);
    } catch {
      throw new UnauthorizedException('Invalid token payload');
    }

    // Validate claims
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      throw new UnauthorizedException('Token has expired');
    }

    if (payload.iss !== this.issuer) {
      throw new UnauthorizedException('Invalid token issuer');
    }

    if (payload.aud !== this.audience) {
      throw new UnauthorizedException('Invalid token audience');
    }

    return payload;
  }

  /**
   * Timing-safe string comparison
   */
  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    
    try {
      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Base64 URL encode
   */
  private base64UrlEncode(str: string): string {
    return Buffer.from(str).toString('base64url');
  }

  /**
   * Parse expiration string (e.g., '7d', '24h', '3600s')
   */
  private parseExpiration(exp: string): number {
    const match = exp.match(/^(\d+)([dhms])$/);
    if (!match) {
      throw new Error(`Invalid expiration format: ${exp}`);
    }

    const [, value, unit] = match;
    const num = parseInt(value, 10);

    switch (unit) {
      case 'd': return num * 86400;
      case 'h': return num * 3600;
      case 'm': return num * 60;
      case 's': return num;
      default: throw new Error(`Unknown unit: ${unit}`);
    }
  }
}
```

**Dosya Güncellemeleri:**
- [`src/modules/auth/auth.module.ts`](src/modules/auth/auth.module.ts:8) - JwtService'i providers'a ekle

---

#### 1.2. Admin Guard'ı JWT ile Güncelle

**Dosya:** [`src/modules/admin/guards/admin.guard.ts`](src/modules/admin/guards/admin.guard.ts)

**Değişiklikler:**

```typescript
import { JwtService } from '../../auth/jwt.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService, // ✅ JWT service inject
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Authorization header is required');
    }

    const [bearer, token] = authHeader.split(' ');

    if (bearer?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization format');
    }

    // ✅ Verify JWT token
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify(token);
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // ✅ Check if user is super admin
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        isActive: true,
        isSuperAdmin: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new ForbiddenException('User account is disabled');
    }

    if (!user.isSuperAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    // Attach admin user to request
    request.adminUser = {
      id: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    };

    return true;
  }
}
```

---

#### 1.3. User Guard'ı JWT ile Güncelle

**Dosya:** [`src/modules/account/guards/user.guard.ts`](src/modules/account/guards/user.guard.ts)

**Benzer değişiklikler** - JWT verification ekle, database'den user bilgisi doğrula.

---

#### 1.4. Login Endpoint Ekle

**Yeni Dosya:** `src/modules/auth/auth.controller.ts`

```typescript
import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from './jwt.service';
import { createHash } from 'crypto';

class LoginDto {
  email: string;
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  @Post('login')
  async login(@Body() dto: LoginDto) {
    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        isActive: true,
        isSuperAdmin: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password (assuming bcrypt or similar)
    const passwordHash = createHash('sha256').update(dto.password).digest('hex');
    if (passwordHash !== user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate JWT token
    const token = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 604800, // 7 days in seconds
      user: {
        id: user.id,
        email: user.email,
        isSuperAdmin: user.isSuperAdmin,
      },
    };
  }
}
```

**Not:** Production'da password hashing için `bcrypt` kullanılmalı!

---

### **Phase 2: Admin Authorization Fix** 🔴 CRITICAL

#### 2.1. Admin Controller Query Param Kullanımını Kaldır

**Dosya:** [`src/modules/admin/admin.controller.ts`](src/modules/admin/admin.controller.ts)

**Değiştirilecek Yerler:**

**Önce:**
```typescript
@Post('users/:id/wallet-adjustment')
async adjustUserWallet(
  @Param('id') id: string,
  @Body() dto: WalletAdjustmentDto,
  @Query('_req') req: AdminRequest, // ❌ BAD
) {
  const adminId = req?.adminUser?.id || 'system'; // ❌ Falls back to 'system'
  return this.adminService.adjustUserWallet(id, dto, adminId);
}
```

**Sonra:**
```typescript
@Post('users/:id/wallet-adjustment')
async adjustUserWallet(
  @Param('id') id: string,
  @Body() dto: WalletAdjustmentDto,
  @Req() req: AdminRequest, // ✅ GOOD - decorator-based
) {
  if (!req.adminUser?.id) {
    throw new UnauthorizedException('Admin authentication required');
  }
  const adminId = req.adminUser.id; // ✅ No fallback
  return this.adminService.adjustUserWallet(id, dto, adminId);
}
```

**Güncellenecek Endpoint'ler:**
- Line 169-177: `adjustUserWallet`
- Line 196-204: `adjustOrgWallet`
- Line 221-230: `revokeApiKey`

---

### **Phase 3: Rate Limiting** 🟠 HIGH

#### 3.1. Admin Endpoints'e Rate Limiting Ekle

**Sorun:** Admin endpoints için rate limiting yok. Ancak mevcut `RateLimitGuard` `AuthContext` gerektiriyor (API key-based). Admin endpoints JWT kullanıyor.

**Çözüm 1 (Basit):** Ayrı bir `AdminRateLimitGuard` oluştur - User ID bazlı rate limiting

**Yeni Dosya:** `src/modules/admin/guards/admin-rate-limit.guard.ts`

```typescript
import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { RedisService } from '../../../redis/redis.service';
import { AdminRequest } from './admin.guard';

@Injectable()
export class AdminRateLimitGuard implements CanActivate {
  private readonly ADMIN_RATE_LIMIT = 100; // per hour
  private readonly WINDOW_SECONDS = 3600; // 1 hour

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    
    if (!request.adminUser?.id) {
      throw new Error('AdminRateLimitGuard must be used after AdminGuard');
    }

    const key = `admin:ratelimit:${request.adminUser.id}`;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / this.WINDOW_SECONDS) * this.WINDOW_SECONDS;
    const windowKey = `${key}:${windowStart}`;

    const count = await this.redis.getClient().incr(windowKey);
    
    if (count === 1) {
      await this.redis.getClient().expire(windowKey, this.WINDOW_SECONDS);
    }

    if (count > this.ADMIN_RATE_LIMIT) {
      throw new HttpException(
        {
          error: {
            message: 'Admin rate limit exceeded',
            type: 'rate_limit_error',
            code: 'admin_rate_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
```

**Kullanım:**
```typescript
@Controller('admin')
@UseGuards(AdminGuard, AdminRateLimitGuard) // ✅ Add rate limit
export class AdminController { }
```

---

#### 3.2. Account Endpoints'e Rate Limiting Ekle

**Benzer Yaklaşım:** `UserRateLimitGuard` oluştur

**Dosya:** `src/modules/account/guards/user-rate-limit.guard.ts`

---

### **Phase 4: Bonus Security Fixes** 🟡 MEDIUM

#### 4.1. API Key Timing-Safe Comparison

**Dosya:** [`src/modules/auth/api-key.service.ts`](src/modules/auth/api-key.service.ts:62)

**Değişiklik:**

```typescript
import { timingSafeEqual } from 'crypto';

private async fetchApiKeyFromDb(
  keyHash: string,
): Promise<ApiKeyValidation['apiKey'] | null> {
  const apiKey = await this.prisma.apiKey.findUnique({
    where: { keyHash },
    // ...
  });

  if (!apiKey) {
    return null;
  }

  // ✅ Timing-safe comparison (paranoya için)
  // Not: Database query zaten timing leak'e sebep olur, ama yine de ekleyelim
  const storedHash = Buffer.from(apiKey.keyHash || '', 'hex');
  const providedHash = Buffer.from(keyHash, 'hex');
  
  if (storedHash.length !== providedHash.length || 
      !timingSafeEqual(storedHash, providedHash)) {
    return null;
  }

  // Rest of the code...
}
```

**Not:** Bu değişiklik minimal impact'li çünkü asıl timing leak database query'sinde. Ama security best practice.

---

#### 4.2. IP Allowlist Bypass Fix

**Dosya:** [`src/modules/auth/auth.service.ts`](src/modules/auth/auth.service.ts:125)

**Değişiklik:**

```typescript
private getClientIp(request: FastifyRequest): string {
  // Only trust X-Forwarded-For if behind a known proxy
  const directIp = request.ip;
  
  // Check if direct connection is from trusted proxy
  // (Cloudflare, AWS ALB, etc.)
  const trustedProxies = [
    '127.0.0.1',
    '::1',
    // Add your proxy IPs here
  ];

  const isTrustedProxy = trustedProxies.includes(directIp);

  if (isTrustedProxy) {
    const xForwardedFor = request.headers['x-forwarded-for'];
    if (xForwardedFor) {
      const ips = Array.isArray(xForwardedFor)
        ? xForwardedFor[0].split(',')
        : xForwardedFor.split(',');
      
      // Take the LAST IP before the proxy (most reliable)
      const clientIp = ips[ips.length - 2]?.trim() || ips[0]?.trim();
      if (clientIp) {
        return clientIp;
      }
    }
  }

  // Direct connection or untrusted proxy
  return directIp;
}
```

---

#### 4.3. CORS Configuration Hardening

**Dosya:** [`src/config/config.validation.ts`](src/config/config.validation.ts:10)

**Değişiklik:**

```typescript
CORS_ORIGINS: Joi.string()
  .custom((value, helpers) => {
    // In production, must not be '*'
    if (process.env.NODE_ENV === 'production' && value === '*') {
      return helpers.error('string.production');
    }
    return value;
  })
  .messages({
    'string.production': 'CORS_ORIGINS cannot be "*" in production',
  })
  .required(),
```

**Ek olarak:** `.env.example` dosyasını güncelle:

```bash
# CORS origins (comma-separated, NO WILDCARD in production!)
CORS_ORIGINS=http://localhost:3000,https://app.omniway.ai
```

---

#### 4.4. Stripe Webhook Error Sanitization

**Dosya:** [`src/modules/stripe/stripe-webhook.controller.ts`](src/modules/stripe/stripe-webhook.controller.ts:52)

**Değişiklik:**

```typescript
try {
  event = this.stripeService.constructWebhookEvent(rawBody, signature);
} catch (err) {
  // ✅ Log detailed error internally
  this.logger.warn('Webhook signature verification failed', {
    error: err.message,
    signature: signature?.substring(0, 20), // First 20 chars only
  });
  
  // ✅ Return generic error to client
  throw new BadRequestException('Invalid webhook signature');
}
```

---

## 🧪 Testing Plan

### Unit Tests

1. **JWT Service Tests:**
   - ✅ Token generation
   - ✅ Token verification (valid)
   - ✅ Token verification (expired)
   - ✅ Token verification (invalid signature)
   - ✅ Token verification (tampered payload)

2. **Guard Tests:**
   - ✅ Admin Guard with valid JWT
   - ✅ Admin Guard with invalid JWT
   - ✅ Admin Guard with non-admin user
   - ✅ User Guard with valid JWT
   - ✅ Rate limit guards

### Integration Tests

1. **Login Flow:**
   ```bash
   curl -X POST http://localhost:3000/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "admin@example.com", "password": "test123"}'
   ```

2. **Admin Access with JWT:**
   ```bash
   curl http://localhost:3000/v1/admin/users \
     -H "Authorization: Bearer <JWT_TOKEN>"
   ```

3. **Rate Limiting:**
   ```bash
   # Send 101 requests rapidly
   for i in {1..101}; do
     curl http://localhost:3000/v1/admin/users \
       -H "Authorization: Bearer <JWT_TOKEN>" &
   done
   # Expected: Last request should return 429 Too Many Requests
   ```

### Security Tests

1. **JWT Tampering Test:**
   - Modify JWT payload
   - Verify server rejects tampered token

2. **IP Spoofing Test:**
   - Send request with fake X-Forwarded-For
   - Verify IP allowlist still enforced

3. **CORS Test:**
   - Request from unauthorized origin
   - Verify request blocked

---

## 📦 Deployment Checklist

### Pre-Deployment

- [ ] All tests passing
- [ ] Code review completed
- [ ] Security audit re-run
- [ ] Documentation updated
- [ ] `.env.example` updated with new requirements

### Deployment Steps

1. **Database Migration (if needed):**
   - Add `passwordHash` column to `User` table (if not exists)

2. **Environment Variables:**
   - Ensure `JWT_SECRET` is set (min 64 chars in production)
   - Update `CORS_ORIGINS` (remove wildcard)

3. **Rolling Deployment:**
   - Deploy to staging first
   - Run security tests
   - Deploy to production

4. **Post-Deployment:**
   - Monitor error logs
   - Check rate limiting metrics
   - Verify JWT authentication working

### Rollback Plan

If issues arise:
1. Revert to previous deployment
2. Investigate issues in staging
3. Fix and re-deploy

---

## 📊 Success Metrics

### Security Metrics
- ✅ Zero authentication bypass attempts successful
- ✅ All admin actions have valid audit trail (no 'system' actor)
- ✅ Rate limiting active on all sensitive endpoints
- ✅ No timing attack vulnerabilities
- ✅ CORS properly restricted in production

### Performance Metrics
- JWT verification < 5ms per request
- Rate limiting overhead < 2ms per request
- No significant increase in Redis load

---

## 🔗 Related Documents

- [`CRITICAL_SECURITY_AUDIT.md`](CRITICAL_SECURITY_AUDIT.md) - Original audit report
- [`FIXES_ACTION_PLAN.md`](FIXES_ACTION_PLAN.md) - Additional fixes for billing race conditions
- [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md) - General implementation guide

---

## 📝 Notes

### Package.json Dependencies

**Current:** NestJS projesi zaten `@nestjs/jwt` ve `@nestjs/passport` içeriyor mu? Kontrol edelim.

**Eğer yoksa ekle:**
```bash
npm install @nestjs/jwt
npm install @types/jsonwebtoken --save-dev
```

**Veya:** Yukarıdaki custom JWT implementation'ı kullan (dependency-free, daha hafif).

### JWT vs. Passport

Bu planda custom JWT implementation kullandık çünkü:
1. Dependency'leri minimize eder
2. Timing-safe comparison built-in
3. Tam kontrol sağlar
4. Audit için daha şeffaf

Eğer tercih ederseniz `@nestjs/jwt` + `passport-jwt` de kullanılabilir.

---

**End of Implementation Plan**

Bu planı onayladıktan sonra Code mode'a geçip implementation'a başlayabiliriz! 🚀
