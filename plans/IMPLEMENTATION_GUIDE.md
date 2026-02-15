# Omniway.ai Backend Implementation Guide

> **Version:** 1.7.7 (PRODUCTION READY - SHIP BLOCKERS RESOLVED)
> **Last Updated:** 2026-01-26
> **Stack:** NestJS + Fastify + PostgreSQL + **Prisma** + Redis + BullMQ + Stripe

> ⚠️ **Critical Fixes Applied:** This version includes all previous fixes + **Wallet Billing (Daily Allowance + Top-up Balance)** and a new **BillingGuard**.
> Includes: Circuit Breaker, Key Pooling, Top-up Packages, Model Access Guard, **Allowance-or-Wallet Atomic Billing**, Wallet Refund (TTFB=0).
>
> **v1.7.1 Prisma Fixes:** Partial unique indexes via raw SQL, XOR check constraints, safe JSON defaults, RequestEvent→PricingSnapshot relation, partition notes, UTC midnight TTL calculation.
>
> **v1.7.2 Final Tuning:** ownerType namespace in Redis keys, BigInt safety, refund TTL fix, idempotency key standard, upstream error classification, PR/Sprint plan.
>
> **v1.7.3 Production Blockers Fixed:** BigInt safety in Lua (INCRBY pattern), idempotency replay policy, synchronous ledger writes, wallet mutation atomicity, circuit breaker state reset bug, migration order fix.
>
> **v1.7.4 Final Consistency Fixes:** ownerType in reconciliation, BigInt(String()) pattern for Node Redis, wallet_balance_cents as string in API responses, idempotency cache size limits.
>
> **v1.7.5 Final Additions:** `/v1/models` response format with capabilities, chargeback wallet lock mechanism, legal reselling permission note.
>
> **v1.7.6 Security & Consistency Fixes:** Owner-scoped idempotency keys (cross-tenant security), single mutation point for wallet (no double-mutate), top-up INCRBY (race condition fix), header whitelist for idempotency cache, BigInt max enforcement clarification.
>
> **v1.7.7 Ship Blockers Resolved:** Response cache owner-scoping fix, Prisma BigInt type fix for increment/decrement, dispute ledger balanceAfterCents fix, Redis wallet cold start bootstrap, refund path order (DB first), comprehensive test scenarios.

---

## Table of Contents

1. [Overview](#overview)  
2. [Architecture](#architecture)  
3. [Phase 1: Foundation](#phase-1-foundation)  
4. [Phase 2: Core API Gateway](#phase-2-core-api-gateway)  
5. [Phase 3: Billing & Wallet](#phase-3-billing--wallet)  
6. [Phase 4: Usage Metering & Dashboard](#phase-4-usage-metering--dashboard)  
7. [Phase 5: Admin & Self-Service](#phase-5-admin--self-service)  
8. [Phase 6: Notifications & Polish](#phase-6-notifications--polish)  
9. [Database Schema](#database-schema)  
10. [Redis Keys Strategy](#redis-keys-strategy)  
11. [API Endpoints Reference](#api-endpoints-reference)  
12. [Environment Variables](#environment-variables)  
13. [Deployment Guide](#deployment-guide)  
14. [Implementation Priority](#implementation-priority)  
15. [Notes & Assumptions](#notes--assumptions)  
16. [Critical Implementation Notes](#critical-implementation-notes)
17. [PR/Sprint Plan](#prsprint-plan)

---

## Overview

**Omniway.ai** is an OpenAI-compatible API gateway that:
- Reverse-proxies requests to upstream LLM providers (OpenAI, Anthropic, Gemini)
- Enforces per-tenant quotas, rate limits, and concurrency limits
- Manages Stripe subscriptions + **wallet top-ups**
- Tracks usage and shows cost savings to users

### Key Business Rules (UPDATED: Daily Allowance + Wallet)

| Rule | Description |
|------|-------------|
| Enforcement Unit | **1 request** is the enforcement unit (MVP request-based). |
| Daily Allowance | Plan includes **X requests/day** (`daily_allowance_requests`). Resets at **UTC 00:00**. |
| Wallet Balance | Users can top-up **money** (`balance_cents`). When allowance is depleted, requests are charged from wallet using **per-model request price**. |
| Spending Order | **Daily Allowance first**, then **Wallet** |
| Rate Limits | per-minute, per-hour, per-day (configurable per plan) |
| Free Trial | Trial plan has daily allowance (e.g., 100/day), no card, **soft-block for the day** when depleted |
| Wallet Refund | Default: NO refund. Exception: **TTFB=0 upstream failures** → refund wallet charge (daily cap + idempotency) |
| Data Retention | request_events: 90 days, usage_daily: 13 months, wallet_ledger: indefinite |

---

## Refund Policy (UPDATED: Wallet Refund Only)

Billing happens **at request start**:

- If request is covered by **daily allowance** → no money deducted
- If request uses **wallet** → `price_cents` is deducted immediately (atomic)

**Exception:** If upstream provider fails **before sending any data** (TTFB = 0):
- Upstream returns 5xx OR
- Connection timeout/refused OR
- DNS failure

Then the **wallet charge** is refunded (same amount), with safeguards:
1. **Idempotency check**: Same `request_id` cannot trigger multiple refunds
2. **Daily cap**: Max 10 refunds per owner per day (abuse prevention)
3. **Audit trail**: All refunds logged in `wallet_ledger` with `type: 'refund_upstream_failure'`

### TTFB Measurement Standard
- TTFB = time from request sent to upstream until **first data byte received**
- For streaming: first SSE chunk (not HTTP headers)
- For non-streaming: response body start
- If connection fails before any data: TTFB = null (eligible)

---

## Free Trial Flow (UPDATED)

1. **Signup**: User registers (email verification required)
2. **Auto-subscription**: System creates "Free Trial" subscription + assigns trial plan (daily allowance set in plan)
3. **Usage**: User creates API key and starts using the API
4. **Daily depletion**: When daily allowance hits 0:
   - Dashboard access: ✅ Active
   - API keys: ✅ Exist (not revoked)
   - API requests: ❌ Return `402 Payment Required` **unless wallet has money**
5. **Top-up**: User tops up wallet or upgrades plan
6. **Reset**: Next UTC day, allowance resets automatically

```json
// 402 Response when allowance depleted + wallet insufficient
// NOTE: wallet_balance_cents is STRING to preserve BigInt precision
{
  "error": {
    "message": "Daily allowance depleted and insufficient wallet balance. Please top-up or upgrade.",
    "type": "insufficient_wallet",
    "code": "payment_required",
    "wallet_balance_cents": "0",
    "upgrade_url": "https://app.omniway.ai/billing"
  }
}
```

---

## Data Retention Policy

| Data Type | Retention | Cleanup Method |
|-----------|-----------|----------------|
| `request_events` | 90 days | Partition drop or scheduled DELETE |
| `usage_daily` | 13 months | Scheduled DELETE |
| `audit_logs` | 2 years | Archive then DELETE |
| `wallet_ledger` | Indefinite | Never delete (financial audit) |
| User PII | Until deletion request | Anonymize on request (GDPR) |

**Partition Strategy for request_events:**

```sql
CREATE TABLE request_events (
    -- ... columns ...
) PARTITION BY RANGE (created_at);

CREATE TABLE request_events_2026_01 PARTITION OF request_events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

DROP TABLE request_events_2025_10;
```

---

## Test Mode vs Production

| Aspect | Test Mode | Production |
|--------|-----------|------------|
| API Key Prefix | `sk_test_` | `sk_live_` |
| Stripe Keys | Test keys | Live keys |
| Upstream | Same providers (real) | Same providers |
| Wallet | Separate wallet balance | Separate wallet balance |
| Rate Limits | Same enforcement | Same enforcement |

**Note:** Test mode uses real upstream calls. For local development without costs, use mock responses.

---

## Upstream Providers

| Provider | Base URL | Models |
|----------|----------|--------|
| OpenAI Provider | `https://api.o7.team/openai` | GPT-4, GPT-3.5, etc. |
| Anthropic Provider | `https://api.o7.team/anthropic` | Claude models |
| OpenAI Compatible | `https://api.o7.team/openai-compatible` | Gemini models ONLY |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OMNIWAY.AI BACKEND                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────────┐   │
│  │   Client    │────▶│  API Gateway │────▶│     Upstream Providers      │   │
│  │  (SDK/HTTP) │◀────│  (NestJS)    │◀────│  OpenAI/Anthropic/Gemini   │   │
│  └─────────────┘     └──────┬──────┘     └─────────────────────────────┘   │
│                             │                                               │
│                             │ Events                                        │
│                             ▼                                               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────────┐   │
│  │   Redis     │◀───▶│   BullMQ    │────▶│     Worker Service          │   │
│  │ Rate Limits │     │   Queues    │     │  - Usage Persistence        │   │
│  │ Allowance   │     │             │     │  - Email Notifications      │   │
│  │ Wallet Cache│     │             │     │  - Stripe Webhook Retry     │   │
│  └─────────────┘     └─────────────┘     └──────────┬──────────────────┘   │
│                                                      │                      │
│                                                      ▼                      │
│                                          ┌─────────────────────────────┐   │
│                                          │      PostgreSQL             │   │
│                                          │  - Users, Orgs, Keys        │   │
│                                          │  - Wallet Ledger            │   │
│                                          │  - Usage Events             │   │
│                                          │  - Audit Logs               │   │
│                                          └─────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Responsibility |
|-----------|----------------|
| **API Gateway** | Auth, rate limiting, routing, proxying, streaming |
| **Worker Service** | Async tasks: usage persistence, emails, webhook retries |
| **Redis** | Rate limit counters, allowance usage, wallet hot-cache, BullMQ backend |
| **PostgreSQL** | Persistent data: users, wallet ledger/balance, usage, audit |
| **Stripe** | Payment processing, subscriptions, top-ups, webhooks |

---

## Phase 1: Foundation

**Goal:** Set up project structure, database, and basic infrastructure.

### Tasks

#### 1.1 Project Setup

```bash
# Create NestJS project with Fastify
nest new omniway-be --package-manager=pnpm
cd omniway-be
pnpm add @nestjs/platform-fastify fastify
pnpm add @nestjs/config
pnpm add prisma @prisma/client
pnpm add @nestjs/bullmq bullmq ioredis
pnpm add class-validator class-transformer
pnpm add uuid nanoid
pnpm add -D @types/node typescript
```

#### 1.2 Folder Structure

```
src/
├── main.ts
├── app.module.ts
├── config/
├── common/
├── prisma/
│   └── prisma.service.ts
└── modules/
    ├── auth/
    ├── users/
    ├── organizations/
    ├── projects/
    ├── api-keys/
    ├── plans/
    ├── billing/          # Stripe + wallet
    ├── wallet/           # wallet balances + ledger
    ├── gateway/          # proxy core
    ├── rate-limit/
    ├── usage/
    ├── models/
    ├── notifications/
    └── admin/
workers/
prisma/
├── schema.prisma
└── migrations/
```

#### 1.3 Database Setup (Docker Compose)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: omniway
      POSTGRES_PASSWORD: omniway_dev
      POSTGRES_DB: omniway
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

#### 1.4 Prisma Schema (Phase 1)

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id              String    @id @default(uuid()) @db.Uuid
  email           String    @unique @db.VarChar(255)
  emailVerifiedAt DateTime? @map("email_verified_at")
  passwordHash    String?   @map("password_hash") @db.VarChar(255)
  name            String?   @db.VarChar(255)
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  deletedAt       DateTime? @map("deleted_at")

  // Relations
  ownedOrganizations Organization[] @relation("OrganizationOwner")
  memberships        Membership[]
  apiKeys            ApiKey[]
  subscription       Subscription?  @relation("UserSubscription")
  walletBalance      WalletBalance? @relation("UserWallet")
  walletLedger       WalletLedger[] @relation("UserWalletLedger")
  requestEvents      RequestEvent[]
  usageDaily         UsageDaily[]
  auditLogs          AuditLog[]     @relation("AuditLogActor")
  notificationPrefs  NotificationPreference?
  invitationsSent    OrganizationInvitation[]

  @@map("users")
}

model Organization {
  id        String    @id @default(uuid()) @db.Uuid
  name      String    @db.VarChar(255)
  slug      String    @db.VarChar(255)
  ownerId   String    @map("owner_id") @db.Uuid
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  // Relations
  owner         User                     @relation("OrganizationOwner", fields: [ownerId], references: [id])
  memberships   Membership[]
  projects      Project[]
  subscription  Subscription?            @relation("OrgSubscription")
  walletBalance WalletBalance?           @relation("OrgWallet")
  walletLedger  WalletLedger[]           @relation("OrgWalletLedger")
  invitations   OrganizationInvitation[]
  requestEvents RequestEvent[]
  usageDaily    UsageDaily[]

  // NOTE: Partial unique index created via raw SQL migration (see below)
  // @@unique([slug]) is NOT used here because we need WHERE deleted_at IS NULL
  @@map("organizations")
}

model Membership {
  id             String    @id @default(uuid()) @db.Uuid
  userId         String    @map("user_id") @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  role           String    @default("developer") @db.VarChar(50)
  status         String    @default("pending") @db.VarChar(50)
  invitedAt      DateTime  @default(now()) @map("invited_at")
  acceptedAt     DateTime? @map("accepted_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")
  deletedAt      DateTime? @map("deleted_at")

  // Relations
  user         User         @relation(fields: [userId], references: [id])
  organization Organization @relation(fields: [organizationId], references: [id])

  // NOTE: Partial unique index created via raw SQL migration (see below)
  // @@unique([userId, organizationId]) is NOT used here because we need WHERE deleted_at IS NULL
  @@map("memberships")
}

model Project {
  id             String    @id @default(uuid()) @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  name           String    @db.VarChar(255)
  slug           String    @db.VarChar(255)
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")
  deletedAt      DateTime? @map("deleted_at")

  // Relations
  organization  Organization   @relation(fields: [organizationId], references: [id])
  apiKeys       ApiKey[]
  requestEvents RequestEvent[]

  // NOTE: Partial unique index created via raw SQL migration (see below)
  // @@unique([organizationId, slug]) is NOT used here because we need WHERE deleted_at IS NULL
  @@map("projects")
}

model Plan {
  id                       String    @id @default(uuid()) @db.Uuid
  name                     String    @db.VarChar(255)
  slug                     String    @unique @db.VarChar(255)
  type                     String    @db.VarChar(50) // individual, agency, custom
  isActive                 Boolean   @default(true) @map("is_active")

  // Rate Limits
  requestsPerMinute        Int?      @map("requests_per_minute")
  requestsPerHour          Int?      @map("requests_per_hour")
  requestsPerDay           Int?      @map("requests_per_day")
  maxConcurrentRequests    Int       @default(10) @map("max_concurrent_requests")
  maxRequestBodyBytes      Int       @default(1048576) @map("max_request_body_bytes")
  maxStreamDurationSeconds Int       @default(300) @map("max_stream_duration_seconds")

  // Seats (for agency)
  seatsIncluded            Int       @default(1) @map("seats_included")
  maxSeats                 Int?      @map("max_seats")

  // Daily Allowance + Topup
  dailyAllowanceRequests   Int       @default(0) @map("daily_allowance_requests")
  allowTopup               Boolean   @default(true) @map("allow_topup")
  allowTopupOnlyAfterSubEnds Boolean @default(false) @map("allow_topup_only_after_subscription_ends")

  // Stripe
  stripePriceId            String?   @map("stripe_price_id") @db.VarChar(255)
  stripeSeatPriceId        String?   @map("stripe_seat_price_id") @db.VarChar(255)

  // Model access
  allowedModels            Json?     @map("allowed_models")

  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @updatedAt @map("updated_at")

  // Relations
  subscriptions            Subscription[]

  @@map("plans")
}

model OrganizationInvitation {
  id             String    @id @default(uuid()) @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  email          String    @db.VarChar(255)
  role           String    @default("developer") @db.VarChar(50)
  token          String    @unique @db.VarChar(255)
  invitedByUserId String   @map("invited_by_user_id") @db.Uuid
  expiresAt      DateTime  @map("expires_at")
  acceptedAt     DateTime? @map("accepted_at")
  canceledAt     DateTime? @map("canceled_at")
  status         String    @default("pending") @db.VarChar(50)
  createdAt      DateTime  @default(now()) @map("created_at")

  // Relations
  organization   Organization @relation(fields: [organizationId], references: [id])
  invitedBy      User         @relation(fields: [invitedByUserId], references: [id])

  // NOTE: Partial unique index created via raw SQL migration (see below)
  // @@unique([organizationId, email]) is NOT used here because we need WHERE status = 'pending'
  @@map("organization_invitations")
}
```

#### 1.5 Prisma Partial Unique Indexes & Check Constraints (Raw SQL Migration)

**IMPORTANT:** Prisma does not support partial unique indexes or check constraints natively.
These MUST be added via raw SQL migration.

Create a migration with `npx prisma migrate dev --create-only --name constraints_indexes`, then add:

```sql
-- prisma/migrations/*_constraints_indexes/migration.sql

-- =====================================================
-- PARTIAL UNIQUE INDEXES (soft-delete / pending status)
-- =====================================================

-- Organizations: slug unique only when not soft-deleted
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug_active
  ON organizations(slug) WHERE deleted_at IS NULL;

-- Projects: (org_id, slug) unique only when not soft-deleted
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_org_slug_active
  ON projects(organization_id, slug) WHERE deleted_at IS NULL;

-- Memberships: (user_id, org_id) unique only when not soft-deleted
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_org_active
  ON memberships(user_id, organization_id) WHERE deleted_at IS NULL;

-- Invitations: (org_id, email) unique only when pending
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_org_email_pending
  ON organization_invitations(organization_id, email)
  WHERE status = 'pending';

-- =====================================================
-- XOR CHECK CONSTRAINTS (owner validation)
-- =====================================================

-- api_keys: must have EITHER user_id OR project_id (not both, not neither)
ALTER TABLE api_keys
  ADD CONSTRAINT api_key_owner_check CHECK (
    (user_id IS NOT NULL AND project_id IS NULL) OR
    (user_id IS NULL AND project_id IS NOT NULL)
  );

-- subscriptions: must have EITHER user_id OR organization_id
ALTER TABLE subscriptions
  ADD CONSTRAINT subscription_owner_check CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR
    (user_id IS NULL AND organization_id IS NOT NULL)
  );

-- wallet_balances: must have EITHER user_id OR organization_id
ALTER TABLE wallet_balances
  ADD CONSTRAINT wallet_owner_check CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR
    (user_id IS NULL AND organization_id IS NOT NULL)
  );

-- wallet_ledger: must have EITHER user_id OR organization_id
ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_owner_check CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR
    (user_id IS NULL AND organization_id IS NOT NULL)
  );
```

Then apply with: `npx prisma migrate dev`

#### 1.6 Deliverables Checklist

- [ ] NestJS project with Fastify adapter
- [ ] Docker Compose for local dev
- [ ] Prisma schema and initial migration
- [ ] Config module with env validation
- [ ] Health check endpoints (`/health`, `/health/ready`)
- [ ] Graceful shutdown handling
- [ ] Structured JSON logging setup

---

## Phase 2: Core API Gateway

**Goal:** Implement the OpenAI-compatible proxy with auth and rate limiting.

### Tasks

#### 2.1 API Keys (Prisma Schema)

```prisma
model ApiKey {
  id         String    @id @default(uuid()) @db.Uuid
  
  userId     String?   @map("user_id") @db.Uuid
  projectId  String?   @map("project_id") @db.Uuid
  
  keyPrefix  String    @map("key_prefix") @db.VarChar(20)
  keyHash    String    @map("key_hash") @db.VarChar(255)
  name       String?   @db.VarChar(255)
  
  // Safe JSON default using dbgenerated for Postgres
  scopes     Json      @default(dbgenerated("'[\"*\"]'::jsonb"))
  allowedIps Json?     @map("allowed_ips")
  
  isActive   Boolean   @default(true) @map("is_active")
  lastUsedAt DateTime? @map("last_used_at")
  revokedAt  DateTime? @map("revoked_at")
  expiresAt  DateTime? @map("expires_at")
  
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")
  
  // Relations
  user          User?          @relation(fields: [userId], references: [id])
  project       Project?       @relation(fields: [projectId], references: [id])
  requestEvents RequestEvent[]

  // NOTE: XOR constraint (user_id OR project_id) enforced via raw SQL migration
  @@index([keyPrefix], map: "idx_api_keys_prefix")
  @@index([userId], map: "idx_api_keys_user")
  @@index([projectId], map: "idx_api_keys_project")
  @@map("api_keys")
}
```

#### 2.1.1 API Key Hashing Standard

```typescript
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const API_KEY_PEPPER = process.env.API_KEY_PEPPER; // 32+ random bytes

function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = 'sk_live_';
  const randomPart = randomBytes(18).toString('base64url');
  const key = prefix + randomPart;

  const lookupPrefix = key.substring(0, 20);

  const hash = createHash('sha256')
    .update(key + API_KEY_PEPPER)
    .digest('hex');

  return { key, prefix: lookupPrefix, hash };
}

function verifyApiKey(providedKey: string, storedHash: string): boolean {
  const computedHash = createHash('sha256')
    .update(providedKey + API_KEY_PEPPER)
    .digest('hex');

  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

#### 2.2 Model Catalog (Prisma Schema)

```prisma
model ModelCatalog {
  id                     String    @id @default(uuid()) @db.Uuid
  
  publicModelName        String    @unique @map("public_model_name") @db.VarChar(255)
  providerRoute          String    @map("provider_route") @db.VarChar(50)
  providerModelId        String    @map("provider_model_id") @db.VarChar(255)
  
  // Safe JSON default using dbgenerated for Postgres
  capabilities           Json      @default(dbgenerated("'{}'::jsonb"))
  
  status                 String    @default("active") @db.VarChar(50)
  deprecationDate        DateTime? @map("deprecation_date") @db.Date
  disableDate            DateTime? @map("disable_date") @db.Date
  
  displayInputPricePer1k  Decimal? @map("display_input_price_per_1k") @db.Decimal(10, 6)
  displayOutputPricePer1k Decimal? @map("display_output_price_per_1k") @db.Decimal(10, 6)
  
  defaultEnabledPlans    Json?     @map("default_enabled_plans")
  
  createdAt              DateTime  @default(now()) @map("created_at")
  updatedAt              DateTime  @updatedAt @map("updated_at")

  @@map("model_catalog")
}
```

**Note:** Token pricing is for "equivalent cost" analytics only (Phase 4). Actual user billing in v1.7 is request-based via `model_request_pricing`.

#### 2.3 Rate Limiting (Redis Lua Script)

```lua
-- scripts/rate_limit.lua
-- KEYS[1] = minute key, KEYS[2] = hour key, KEYS[3] = day key
-- ARGV[1] = minute limit, ARGV[2] = hour limit, ARGV[3] = day limit

local minute_key = KEYS[1]
local hour_key = KEYS[2]
local day_key = KEYS[3]

local minute_limit = tonumber(ARGV[1])
local hour_limit = tonumber(ARGV[2])
local day_limit = tonumber(ARGV[3])

local now = tonumber(redis.call('TIME')[1])

local minute_count = tonumber(redis.call('GET', minute_key) or '0')
local hour_count = tonumber(redis.call('GET', hour_key) or '0')
local day_count = tonumber(redis.call('GET', day_key) or '0')

local minute_ttl = 60 - (now % 60)
local hour_ttl = 3600 - (now % 3600)
local day_ttl = 86400 - (now % 86400)

if minute_ttl < 1 then minute_ttl = 60 end
if hour_ttl < 1 then hour_ttl = 3600 end
if day_ttl < 1 then day_ttl = 86400 end

if minute_limit > 0 and minute_count >= minute_limit then
    return {0, 'minute', minute_count, minute_limit, minute_ttl}
end
if hour_limit > 0 and hour_count >= hour_limit then
    return {0, 'hour', hour_count, hour_limit, hour_ttl}
end
if day_limit > 0 and day_count >= day_limit then
    return {0, 'day', day_count, day_limit, day_ttl}
end

local new_minute = redis.call('INCR', minute_key)
if new_minute == 1 then redis.call('EXPIRE', minute_key, minute_ttl) end

local new_hour = redis.call('INCR', hour_key)
if new_hour == 1 then redis.call('EXPIRE', hour_key, hour_ttl) end

local new_day = redis.call('INCR', day_key)
if new_day == 1 then redis.call('EXPIRE', day_key, day_ttl) end

return {1, 'ok', new_day, day_limit, 0}
```

#### 2.4 Concurrency Limiting (Redis Lua Script)

```lua
-- scripts/concurrency.lua
-- KEYS[1] = concurrency key
-- ARGV[1] = max concurrent
-- ARGV[2] = request_id
-- ARGV[3] = ttl (max request duration)
-- ARGV[4] = action: 'acquire' or 'release'

local key = KEYS[1]
local max_concurrent = tonumber(ARGV[1])
local request_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local action = ARGV[4]

if action == 'acquire' then
    local now = tonumber(redis.call('TIME')[1])
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

    local existing = redis.call('ZSCORE', key, request_id)
    if existing then
        local current = redis.call('ZCARD', key)
        return {1, current, max_concurrent, 'already_acquired'}
    end

    local current = redis.call('ZCARD', key)
    if current >= max_concurrent then
        return {0, current, max_concurrent, 'limit_reached'}
    end

    redis.call('ZADD', key, now + ttl, request_id)
    return {1, current + 1, max_concurrent, 'acquired'}

elseif action == 'release' then
    redis.call('ZREM', key, request_id)
    local current = redis.call('ZCARD', key)
    return {1, current, max_concurrent}
end

return {0, 0, 0}
```

#### 2.5 Gateway Flow (UPDATED)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         REQUEST FLOW (UPDATED)                          │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Request arrives at POST /v1/chat/completions                        │
│  2. AuthGuard: Validate API key + load owner + plan                     │
│  3. RateLimitGuard: Check minute/hour/day limits                        │
│  4. ConcurrencyGuard: Acquire slot                                      │
│  5. ModelResolver: Resolve model → provider route                       │
│  6. ModelAccessGuard: Check plan.allowed_models                         │
│     └─▶ If not allowed: return 403 (NO billing)                         │
│  7. CircuitBreakerCheck: Check upstream health                          │
│     └─▶ If OPEN: return 503 (NO billing)                                │
│  8. BillingGuard: Allowance first, else Wallet charge (atomic)          │
│     └─▶ If wallet insufficient: return 402 Payment Required             │
│  9. RequestTransformer: Transform to provider format                    │
│ 10. Proxy: Forward to upstream                                          │
│ 11. ResponseTransformer: Normalize to OpenAI format                     │
│ 12. Release concurrency slot                                            │
│ 13. Emit RequestCompleted event to BullMQ (async)                       │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 2.6 Deliverables Checklist

- [ ] API key generation (show once, store hashed)
- [ ] API key authentication guard
- [ ] Rate limiting with Redis Lua script
- [ ] Concurrency limiting with Redis Lua script
- [ ] Model catalog and routing
- [ ] Request transformation (OpenAI → Anthropic)
- [ ] Response transformation (Anthropic → OpenAI)
- [ ] SSE streaming support
- [ ] Error standardization
- [ ] `x-request-id` header on all responses
- [ ] Idempotency-Key support for non-streaming

#### 2.7 Upstream Health, Circuit Breaker & Adaptive Throttling

**Why MVP-critical:** Protects your system from upstream 429/5xx waves.

##### Redis Health State

```
up:health:{provider} → JSON { fail_count, success_count, state, open_until, throttle_factor }
States: CLOSED, OPEN, HALF_OPEN
```

##### Circuit Breaker Configuration

```typescript
interface CircuitBreakerConfig {
  failureThreshold: number;
  failureWindowMs: number;
  openDurationMs: number;
  halfOpenMaxRequests: number;
  throttleSteps: number[];
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 10,
  failureWindowMs: 60_000,
  openDurationMs: 30_000,
  halfOpenMaxRequests: 5,
  throttleSteps: [1.0, 0.7, 0.4, 0.2],
};
```

##### Circuit Breaker Lua Script (v1.7.3 - State Reset Bug Fixed)

> ⚠️ **v1.7.3 CRITICAL FIX:** Previous version did not reset `success_count`, `fail_count`, and `window_start`
> on OPEN→HALF_OPEN transition. This caused incorrect state accumulation.

```lua
-- scripts/circuit_breaker.lua
-- KEYS[1] = up:health:{provider}
-- ARGV[1] = action: 'check' | 'record_success' | 'record_failure'
-- ARGV[2] = failure_threshold
-- ARGV[3] = failure_window_ms
-- ARGV[4] = open_duration_ms
-- ARGV[5] = half_open_max_requests
-- ARGV[6] = throttle_steps (JSON array)

local key = KEYS[1]
local action = ARGV[1]
local failure_threshold = tonumber(ARGV[2])
local failure_window_ms = tonumber(ARGV[3])
local open_duration_ms = tonumber(ARGV[4])
local half_open_max = tonumber(ARGV[5])
local throttle_steps = cjson.decode(ARGV[6])

local now = tonumber(redis.call('TIME')[1]) * 1000  -- ms

-- Get or init state
local state_json = redis.call('GET', key)
local state
if state_json then
    state = cjson.decode(state_json)
else
    state = {
        state = 'CLOSED',
        fail_count = 0,
        success_count = 0,
        window_start = now,
        open_until = 0,
        half_open_requests = 0,
        throttle_index = 1
    }
end

-- Helper: save state
local function save()
    redis.call('SETEX', key, 300, cjson.encode(state))  -- 5min TTL
end

-- Helper: get throttle factor
local function get_throttle()
    return throttle_steps[state.throttle_index] or throttle_steps[#throttle_steps]
end

if action == 'check' then
    -- Check if circuit allows request
    if state.state == 'OPEN' then
        if now >= state.open_until then
            -- Transition to HALF_OPEN
            -- v1.7.3 FIX: Reset ALL counters for clean HALF_OPEN state
            state.state = 'HALF_OPEN'
            state.half_open_requests = 0
            state.success_count = 0      -- v1.7.3 FIX
            state.fail_count = 0         -- v1.7.3 FIX
            state.window_start = now     -- v1.7.3 FIX
            save()
            return {1, 'HALF_OPEN', get_throttle(), state.half_open_requests}
        else
            return {0, 'OPEN', 0, math.ceil((state.open_until - now) / 1000)}
        end
    elseif state.state == 'HALF_OPEN' then
        if state.half_open_requests >= half_open_max then
            return {0, 'HALF_OPEN_FULL', get_throttle(), state.half_open_requests}
        end
        state.half_open_requests = state.half_open_requests + 1
        save()
        return {1, 'HALF_OPEN', get_throttle(), state.half_open_requests}
    else
        return {1, 'CLOSED', get_throttle(), 0}
    end

elseif action == 'record_success' then
    if state.state == 'HALF_OPEN' then
        state.success_count = state.success_count + 1
        if state.success_count >= half_open_max then
            -- Fully recovered
            state.state = 'CLOSED'
            state.fail_count = 0
            state.success_count = 0
            state.window_start = now     -- v1.7.3 FIX: Reset window on recovery
            state.throttle_index = math.max(1, state.throttle_index - 1)
        end
    elseif state.state == 'CLOSED' then
        -- Gradually recover throttle
        if state.throttle_index > 1 then
            state.success_count = state.success_count + 1
            if state.success_count >= 50 then
                state.throttle_index = math.max(1, state.throttle_index - 1)
                state.success_count = 0
            end
        end
    end
    save()
    return {1, state.state, get_throttle()}

elseif action == 'record_failure' then
    -- Reset window if expired
    if now - state.window_start > failure_window_ms then
        state.fail_count = 0
        state.window_start = now
    end
    
    state.fail_count = state.fail_count + 1
    
    if state.state == 'HALF_OPEN' then
        -- Back to OPEN
        state.state = 'OPEN'
        state.open_until = now + open_duration_ms
        state.throttle_index = math.min(#throttle_steps, state.throttle_index + 1)
    elseif state.state == 'CLOSED' and state.fail_count >= failure_threshold then
        -- Open circuit
        state.state = 'OPEN'
        state.open_until = now + open_duration_ms
        state.throttle_index = math.min(#throttle_steps, state.throttle_index + 1)
    end
    
    save()
    return {1, state.state, get_throttle(), state.fail_count}
end

return {0, 'unknown_action'}
```

##### Gateway Integration (Order matters!)

Check circuit breaker **BEFORE billing**. Only record success/failure around the actual upstream proxy.

```typescript
async function proxyWithCircuitBreaker(provider: string, request: Request) {
  // 1. Check circuit breaker
  const [allowed, state, throttleFactor, extra] = await redis.evalsha(
    CIRCUIT_BREAKER_SHA,
    1,
    `up:health:${provider}`,
    'check',
    ...CONFIG_ARGS
  );

  if (!allowed && state === 'OPEN') {
    throw new ServiceUnavailableException({
      error: 'provider_unavailable',
      message: `${provider} is temporarily unavailable. Retry in ${extra}s.`,
      retry_after: extra,
    });
  }

  // 2. Proxy request
  try {
    const response = await proxyToUpstream(provider, request);

    // 3. Record success
    await redis.evalsha(
      CIRCUIT_BREAKER_SHA,
      1,
      `up:health:${provider}`,
      'record_success',
      ...CONFIG_ARGS
    );

    return response;
  } catch (error) {
    // 4. Record failure for 429/5xx or connection errors
    if (isUpstreamFailure(error)) {
      await redis.evalsha(
        CIRCUIT_BREAKER_SHA,
        1,
        `up:health:${provider}`,
        'record_failure',
        ...CONFIG_ARGS
      );
    }
    throw error;
  }
}
```

#### 2.8 Model Access Guard (Plan Enforcement)

```typescript
@Injectable()
export class ModelAccessGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const { model } = request.body;
    const plan = request.user.plan;

    if (plan.allowedModels === null) return true;

    if (!plan.allowedModels.includes(model)) {
      throw new ForbiddenException({
        error: {
          message: `Model '${model}' is not available on your ${plan.name} plan.`,
          type: 'model_not_available',
          code: 'forbidden',
          allowed_models: plan.allowedModels,
          upgrade_url: 'https://app.omniway.ai/billing/upgrade',
        },
      });
    }

    return true;
  }
}
```

---

## Phase 3: Billing & Wallet

**Goal:** Implement Stripe subscriptions + wallet top-ups + allowance-or-wallet billing.

### 3.0 Upstream Key Pooling & Rotation

**Why MVP-critical:** Single upstream key is a single point of failure.

#### upstream_api_keys (Prisma Schema)

```prisma
model UpstreamApiKey {
  id             String    @id @default(uuid()) @db.Uuid
  provider       String    @db.VarChar(50)
  
  keyCiphertext  Bytes     @map("key_ciphertext")
  keyIv          Bytes     @map("key_iv")
  keyTag         Bytes     @map("key_tag")
  
  weight         Int       @default(100)
  status         String    @default("active") @db.VarChar(50)
  
  rateLimitHint  Json?     @map("rate_limit_hint")
  
  coolingUntil   DateTime? @map("cooling_until")
  coolingCount   Int       @default(0) @map("cooling_count")
  
  label          String?   @db.VarChar(255)
  lastUsedAt     DateTime? @map("last_used_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@index([provider, status], map: "idx_upstream_keys_provider_status")
  @@map("upstream_api_keys")
}
```

#### Key Selection Algorithm

```typescript
@Injectable()
export class UpstreamKeyService {
  private keyCache: Map<string, UpstreamKey[]> = new Map();

  async selectKey(provider: string): Promise<{ keyId: string; decryptedKey: string }> {
    const keys = await this.getAvailableKeys(provider);
    if (keys.length === 0) {
      throw new ServiceUnavailableException(`No available API keys for ${provider}`);
    }

    const now = new Date();
    const activeKeys = keys.filter(k => 
      k.status === 'active' && (!k.coolingUntil || k.coolingUntil < now)
    );

    if (activeKeys.length === 0) {
      const soonest = keys
        .filter(k => k.coolingUntil)
        .sort((a, b) => a.coolingUntil!.getTime() - b.coolingUntil!.getTime())[0];
      if (soonest) return this.decryptAndReturn(soonest);
      throw new ServiceUnavailableException(`All API keys for ${provider} are cooling`);
    }

    // Weighted random selection
    const totalWeight = activeKeys.reduce((sum, k) => sum + k.weight, 0);
    let random = Math.random() * totalWeight;
    for (const key of activeKeys) {
      random -= key.weight;
      if (random <= 0) return this.decryptAndReturn(key);
    }
    return this.decryptAndReturn(activeKeys[0]);
  }

  async markKeyCooling(keyId: string, durationMs: number = 60_000): Promise<void> {
    const coolingUntil = new Date(Date.now() + durationMs);
    await this.prisma.upstreamApiKey.update({
      where: { id: keyId },
      data: { coolingUntil, coolingCount: { increment: 1 } },
    });
    this.keyCache.clear();
  }
}
```

### 3.1 Subscriptions (Prisma Schema)

```prisma
model Subscription {
  id                       String    @id @default(uuid()) @db.Uuid
  
  userId                   String?   @unique @map("user_id") @db.Uuid
  organizationId           String?   @unique @map("organization_id") @db.Uuid
  
  planId                   String    @map("plan_id") @db.Uuid
  
  stripeSubscriptionId     String?   @unique @map("stripe_subscription_id") @db.VarChar(255)
  stripeCustomerId         String?   @map("stripe_customer_id") @db.VarChar(255)
  stripeSubscriptionItemId String?   @map("stripe_subscription_item_id") @db.VarChar(255)
  
  status                   String    @default("active") @db.VarChar(50)
  currentPeriodStart       DateTime? @map("current_period_start")
  currentPeriodEnd         DateTime? @map("current_period_end")
  canceledAt               DateTime? @map("canceled_at")
  
  quantity                 Int       @default(1)
  
  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @updatedAt @map("updated_at")

  // Relations
  user         User?        @relation("UserSubscription", fields: [userId], references: [id])
  organization Organization? @relation("OrgSubscription", fields: [organizationId], references: [id])
  plan         Plan         @relation(fields: [planId], references: [id])

  // NOTE: XOR constraint (user_id OR organization_id) enforced via raw SQL migration
  @@map("subscriptions")
}
```

### 3.2 Wallet Tables (Prisma Schema)

#### WalletBalance

```prisma
model WalletBalance {
  id             String   @id @default(uuid()) @db.Uuid
  
  userId         String?  @unique @map("user_id") @db.Uuid
  organizationId String?  @unique @map("organization_id") @db.Uuid
  
  balanceCents   BigInt   @default(0) @map("balance_cents")
  currency       String   @default("USD") @db.VarChar(3)
  
  version        Int      @default(0)
  updatedAt      DateTime @updatedAt @map("updated_at")

  // Relations
  user         User?        @relation("UserWallet", fields: [userId], references: [id])
  organization Organization? @relation("OrgWallet", fields: [organizationId], references: [id])

  // NOTE: XOR constraint (user_id OR organization_id) enforced via raw SQL migration
  @@map("wallet_balances")
}
```

#### WalletLedger (append-only)

```prisma
model WalletLedger {
  id                String   @id @default(uuid()) @db.Uuid
  
  userId            String?  @map("user_id") @db.Uuid
  organizationId    String?  @map("organization_id") @db.Uuid
  
  type              String   @db.VarChar(50) // topup_purchase, charge, refund, adjustment
  amountCents       BigInt   @map("amount_cents") // + topup, - charge
  balanceAfterCents BigInt   @map("balance_after_cents")
  
  referenceType     String?  @map("reference_type") @db.VarChar(50)
  referenceId       String?  @map("reference_id") @db.VarChar(255)
  
  description       String?
  metadata          Json?
  
  createdAt         DateTime @default(now()) @map("created_at")

  // Relations
  user         User?        @relation("UserWalletLedger", fields: [userId], references: [id])
  organization Organization? @relation("OrgWalletLedger", fields: [organizationId], references: [id])

  // NOTE: XOR constraint (user_id OR organization_id) enforced via raw SQL migration
  @@index([userId, createdAt], map: "idx_wallet_ledger_user")
  @@index([organizationId, createdAt], map: "idx_wallet_ledger_org")
  @@map("wallet_ledger")
}
```

### 3.3 Stripe Events (Idempotency)

```prisma
model StripeEvent {
  id            String   @id @default(uuid()) @db.Uuid
  stripeEventId String   @unique @map("stripe_event_id") @db.VarChar(255)
  eventType     String   @map("event_type") @db.VarChar(255)
  processedAt   DateTime @default(now()) @map("processed_at")
  payload       Json?

  @@index([stripeEventId], map: "idx_stripe_events")
  @@map("stripe_events")
}
```

### 3.4 Model Request Pricing (NEW: user billing source of truth)

```prisma
model ModelRequestPricing {
  id              String    @id @default(uuid()) @db.Uuid
  publicModelName String    @map("public_model_name") @db.VarChar(255)
  priceCents      Int       @map("price_cents")
  currency        String    @default("USD") @db.VarChar(3)
  effectiveFrom   DateTime  @default(now()) @map("effective_from")
  effectiveUntil  DateTime? @map("effective_until")
  createdAt       DateTime  @default(now()) @map("created_at")

  @@index([publicModelName, effectiveFrom], map: "idx_model_request_pricing_model")
  @@map("model_request_pricing")
}
```

### 3.5 BillingGuard (Atomic Allowance-or-Wallet)

**Hot path requirements:**
- Single atomic decision (avoid race)
- Idempotent by `request_id` (retries must not double-charge)

#### Redis Keys (used by BillingGuard) — UPDATED v1.7.6 with Owner-Scoped Idempotency

**CRITICAL:** Include `ownerType` in Redis keys to prevent User UUID / Org UUID collision:

> ⚠️ **v1.7.6 SECURITY FIX:** Idempotency keys MUST also be owner-scoped. Since `requestId` can come from
> client-provided `Idempotency-Key` header, two different tenants choosing the same key would share Redis entries
> → cross-tenant data leak, free API calls, wrong cached response replay.

```
allow:used:{ownerType}:{ownerId}:{YYYYMMDD}         → allowance usage counter (TTL until UTC midnight)
wallet:{ownerType}:{ownerId}:balance_cents          → hot wallet cache (no TTL)
idem:billing:{ownerType}:{ownerId}:{requestId}      → billing idempotency (24h) - v1.7.6: owner-scoped
idem:refund:{ownerType}:{ownerId}:{requestId}       → refund idempotency (24h) - v1.7.6: owner-scoped
idem:response:{ownerType}:{ownerId}:{requestId}     → response cache (24h) - v1.7.6: owner-scoped
```

Where `ownerType` = `'user'` or `'org'`

#### Billing Lua Script (v1.7.6 - Owner-Scoped Idempotency)

> ⚠️ **v1.7.3 CRITICAL FIX:** Previous version used `tonumber()` which loses precision for values > 2^53.
> This version uses `INCRBY` for wallet deduction to avoid Lua number precision issues.
> **Wallet balance is enforced to max 2^53-1 cents (~$90 trillion) at top-up time.**

```lua
-- scripts/billing.lua
-- KEYS[1] = allow:used:{ownerType}:{ownerId}:{YYYYMMDD}
-- KEYS[2] = wallet:{ownerType}:{ownerId}:balance_cents
-- KEYS[3] = idem:billing:{ownerType}:{ownerId}:{requestId}  -- v1.7.6: owner-scoped
-- ARGV[1] = daily_allowance_requests
-- ARGV[2] = price_cents (MUST be <= 2^53-1, enforced by application)
-- ARGV[3] = request_id
-- ARGV[4] = idem_ttl_sec (86400)
-- ARGV[5] = day_ttl_sec (seconds until UTC midnight - use secondsUntilUtcMidnight())

local used_key = KEYS[1]
local wallet_key = KEYS[2]
local idem_key = KEYS[3]

local daily_allowance = tonumber(ARGV[1]) or 0
local price_cents = tonumber(ARGV[2]) or 0  -- Safe: price_cents is always small
local idem_ttl = tonumber(ARGV[4]) or 86400
local day_ttl = tonumber(ARGV[5]) or 86400

-- Check idempotency
local cached = redis.call('GET', idem_key)
if cached then
  -- Return cached result (idempotent replay)
  local parts = {}
  for part in string.gmatch(cached, "[^:]+") do table.insert(parts, part) end
  return {2, parts[1], tonumber(parts[2] or '0'), tonumber(parts[3] or '0'), parts[4] or '0'}
end

-- Try allowance first
if daily_allowance > 0 then
  local used = tonumber(redis.call('GET', used_key) or '0')
  if used < daily_allowance then
    local new_used = redis.call('INCR', used_key)
    if new_used == 1 then redis.call('EXPIRE', used_key, day_ttl) end

    local remaining = daily_allowance - new_used
    local balance_str = redis.call('GET', wallet_key) or '0'

    redis.call('SETEX', idem_key, idem_ttl, 'allowance:0:' .. remaining .. ':' .. balance_str)
    return {1, 'allowance', 0, remaining, balance_str}
  end
end

-- Try wallet using INCRBY (BigInt safe - no Lua number conversion)
-- First check if balance is sufficient using string comparison
local balance_str = redis.call('GET', wallet_key) or '0'
local balance_num = tonumber(balance_str) or 0  -- Safe for comparison if < 2^53

if balance_num < price_cents then
  return {0, 'insufficient_wallet', price_cents, balance_str}
end

-- Use INCRBY with negative value (atomic, BigInt safe in Redis)
local new_balance = redis.call('INCRBY', wallet_key, -price_cents)
local new_balance_str = tostring(new_balance)

redis.call('SETEX', idem_key, idem_ttl, 'wallet:' .. price_cents .. ':0:' .. new_balance_str)
return {1, 'wallet', price_cents, 0, new_balance_str}
```

**Return codes:**
- `0` = insufficient wallet (balance returned as string)
- `1` = success (new charge, balance returned as string)
- `2` = idempotent hit (already processed, balance returned as string)

> **Note:** Balance is returned as STRING in return[5] to preserve BigInt precision.
> Application must parse with `BigInt()` not `parseInt()`.

### 3.6 Wallet Refund (TTFB=0) — v1.7.6 Owner-Scoped Idempotency

> ⚠️ **v1.7.3 CRITICAL FIX:** Uses `INCRBY` for wallet credit to avoid Lua number precision issues.
>
> ⚠️ **v1.7.6 SECURITY FIX:** Idempotency key now includes ownerType:ownerId to prevent cross-tenant collisions.

```lua
-- scripts/refund_wallet.lua
-- KEYS[1] = wallet:{ownerType}:{ownerId}:balance_cents
-- KEYS[2] = idem:refund:{ownerType}:{ownerId}:{requestId}  -- v1.7.6: owner-scoped
-- KEYS[3] = refund:{ownerType}:{ownerId}:{YYYYMMDD}
-- ARGV[1] = amount_cents (positive value to refund)
-- ARGV[2] = daily_cap (e.g., 10)
-- ARGV[3] = day_ttl_sec (MUST use secondsUntilUtcMidnight() - CRITICAL!)
-- ARGV[4] = idem_ttl_sec (86400)

local wallet_key = KEYS[1]
local idem_key = KEYS[2]
local cap_key = KEYS[3]

local amount = tonumber(ARGV[1]) or 0  -- Safe: refund amounts are always small
local cap = tonumber(ARGV[2]) or 10
local day_ttl = tonumber(ARGV[3]) or 86400
local idem_ttl = tonumber(ARGV[4]) or 86400

if amount <= 0 then
  return {0, 'nothing_to_refund', '0'}
end

if redis.call('EXISTS', idem_key) == 1 then
  return {0, 'already_refunded', '0'}
end

local count = tonumber(redis.call('GET', cap_key) or '0')
if count >= cap then
  return {0, 'daily_cap_exceeded', tostring(count)}
end

-- Use INCRBY for BigInt-safe addition
local new_balance = redis.call('INCRBY', wallet_key, amount)
local new_balance_str = tostring(new_balance)

redis.call('INCR', cap_key)
redis.call('EXPIRE', cap_key, day_ttl)

redis.call('SETEX', idem_key, idem_ttl, '1')
return {1, 'refunded', new_balance_str, count + 1}
```

> **Note:** Balance is returned as STRING in return[3] to preserve BigInt precision.

### 3.7 Stripe Webhook Handler (UPDATED)

```typescript
const STRIPE_EVENTS = {
  'checkout.session.completed': 'handleCheckoutCompleted',
  'invoice.paid': 'handleInvoicePaid',
  'invoice.payment_failed': 'handlePaymentFailed',
  'customer.subscription.updated': 'handleSubscriptionUpdated',
  'customer.subscription.deleted': 'handleSubscriptionDeleted',
  'charge.dispute.created': 'handleDisputeCreated',
  'charge.dispute.closed': 'handleDisputeClosed',
  'charge.refunded': 'handleRefund',
};
```

### 3.7.1 Chargeback & Dispute Handling (v1.7.5)

When a customer disputes a charge (chargeback), you must:
1. **Lock the wallet** to prevent further usage until resolved
2. **Track dispute status** for audit
3. **Handle resolution** (won or lost)

#### Wallet Lock Mechanism

```prisma
// Add to WalletBalance model
model WalletBalance {
  // ... existing fields ...
  
  // v1.7.5: Dispute/chargeback lock
  lockedAt         DateTime? @map("locked_at")
  lockedReason     String?   @map("locked_reason") @db.VarChar(255)
  lockedByDisputeId String?  @map("locked_by_dispute_id") @db.VarChar(255)
}
```

#### Dispute Event Handlers

```typescript
async function handleDisputeCreated(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntentId = dispute.payment_intent as string;
  
  // 1. Find the affected owner (user or org)
  const owner = await findOwnerByPaymentIntent(paymentIntentId);
  if (!owner) {
    logger.warn('Dispute for unknown payment intent', { paymentIntentId });
    return;
  }
  
  // 2. Lock the wallet immediately
  await prisma.$transaction(async (tx) => {
    // v1.7.7 FIX: Capture wallet state BEFORE update for accurate ledger entry
    const wallet = await tx.walletBalance.update({
      where: owner.ownerType === 'user'
        ? { userId: owner.ownerId }
        : { organizationId: owner.ownerId },
      data: {
        lockedAt: new Date(),
        lockedReason: `Stripe dispute: ${dispute.reason}`,
        lockedByDisputeId: dispute.id,
      },
    });
    
    // 3. Log to ledger for audit trail
    // v1.7.7 FIX: balanceAfterCents must reflect actual wallet balance, not 0n
    await tx.walletLedger.create({
      data: {
        userId: owner.ownerType === 'user' ? owner.ownerId : null,
        organizationId: owner.ownerType === 'org' ? owner.ownerId : null,
        type: 'dispute_lock',
        amountCents: 0n,
        balanceAfterCents: wallet.balanceCents,  // v1.7.7 FIX: Use actual balance
        referenceType: 'stripe_dispute',
        referenceId: dispute.id,
        description: `Wallet locked: Dispute ${dispute.reason}`,
        metadata: {
          disputeId: dispute.id,
          paymentIntentId,
          reason: dispute.reason,
          amount: dispute.amount,
        },
      },
    });
  });
  
  // 4. Invalidate Redis cache to enforce lock immediately
  const redisKey = `wallet:${owner.ownerType}:${owner.ownerId}:balance_cents`;
  await redis.set(`${redisKey}:locked`, '1');
  
  // 5. Send notification to user
  await notificationQueue.add('dispute-created', {
    userId: owner.ownerType === 'user' ? owner.ownerId : null,
    orgId: owner.ownerType === 'org' ? owner.ownerId : null,
    disputeId: dispute.id,
    amount: dispute.amount,
  });
  
  logger.info('Wallet locked due to dispute', {
    ownerId: owner.ownerId,
    ownerType: owner.ownerType,
    disputeId: dispute.id,
  });
}

async function handleDisputeClosed(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  
  // Find the affected owner
  const owner = await findOwnerByDisputeId(dispute.id);
  if (!owner) return;
  
  if (dispute.status === 'won') {
    // Dispute won - unlock wallet
    await unlockWallet(owner, dispute.id, 'dispute_won');
  } else if (dispute.status === 'lost') {
    // Dispute lost - deduct the disputed amount from wallet
    await handleDisputeLost(owner, dispute);
  }
}

async function unlockWallet(
  owner: { ownerType: 'user' | 'org'; ownerId: string },
  disputeId: string,
  reason: string
) {
  await prisma.$transaction(async (tx) => {
    const wallet = await tx.walletBalance.update({
      where: owner.ownerType === 'user'
        ? { userId: owner.ownerId }
        : { organizationId: owner.ownerId },
      data: {
        lockedAt: null,
        lockedReason: null,
        lockedByDisputeId: null,
      },
    });
    
    await tx.walletLedger.create({
      data: {
        userId: owner.ownerType === 'user' ? owner.ownerId : null,
        organizationId: owner.ownerType === 'org' ? owner.ownerId : null,
        type: 'dispute_unlock',
        amountCents: 0n,
        balanceAfterCents: wallet.balanceCents,
        referenceType: 'stripe_dispute',
        referenceId: disputeId,
        description: `Wallet unlocked: ${reason}`,
      },
    });
  });
  
  // Clear Redis lock
  const redisKey = `wallet:${owner.ownerType}:${owner.ownerId}:balance_cents`;
  await redis.del(`${redisKey}:locked`);
  
  logger.info('Wallet unlocked after dispute resolution', {
    ownerId: owner.ownerId,
    ownerType: owner.ownerType,
    disputeId,
    reason,
  });
}

async function handleDisputeLost(
  owner: { ownerType: 'user' | 'org'; ownerId: string },
  dispute: Stripe.Dispute
) {
  // Dispute lost - the disputed amount should be deducted
  // Note: Stripe already deducted from your account, so we deduct from user's wallet
  const amountCents = dispute.amount; // Amount in cents
  
  await prisma.$transaction(async (tx) => {
    const wallet = await tx.walletBalance.update({
      where: owner.ownerType === 'user'
        ? { userId: owner.ownerId }
        : { organizationId: owner.ownerId },
      data: {
        // v1.7.7 FIX: Prisma BigInt requires BigInt() wrapper for increment/decrement
        balanceCents: { decrement: BigInt(amountCents) },
        lockedAt: null,
        lockedReason: null,
        lockedByDisputeId: null,
      },
    });
    
    await tx.walletLedger.create({
      data: {
        userId: owner.ownerType === 'user' ? owner.ownerId : null,
        organizationId: owner.ownerType === 'org' ? owner.ownerId : null,
        type: 'chargeback_deduction',
        amountCents: BigInt(-amountCents),
        balanceAfterCents: wallet.balanceCents,
        referenceType: 'stripe_dispute',
        referenceId: dispute.id,
        description: `Chargeback: ${dispute.reason}`,
        metadata: {
          disputeId: dispute.id,
          originalAmount: amountCents,
          status: 'lost',
        },
      },
    });
  });
  
  // Update Redis
  const redisKey = `wallet:${owner.ownerType}:${owner.ownerId}:balance_cents`;
  await redis.incrby(redisKey, -amountCents);
  await redis.del(`${redisKey}:locked`);
  
  // Notify user
  await notificationQueue.add('chargeback-processed', {
    userId: owner.ownerType === 'user' ? owner.ownerId : null,
    orgId: owner.ownerType === 'org' ? owner.ownerId : null,
    disputeId: dispute.id,
    amount: amountCents,
    status: 'lost',
  });
}
```

#### BillingGuard Lock Check

Update BillingGuard to check for wallet lock before charging:

```typescript
// In BillingGuard, before Lua script call:
async function checkWalletLock(ownerType: 'user' | 'org', ownerId: string): Promise<boolean> {
  const lockKey = `wallet:${ownerType}:${ownerId}:balance_cents:locked`;
  const isLocked = await redis.get(lockKey);
  return isLocked === '1';
}

// In canActivate():
if (await checkWalletLock(ctx.ownerType, ctx.ownerId)) {
  throw new PaymentRequiredException({
    error: {
      message: 'Your account is temporarily locked due to a payment dispute. Please contact support.',
      type: 'account_locked',
      code: 'dispute_pending',
      support_url: 'https://support.omniway.ai',
    },
  });
}
```

#### Redis Keys for Dispute

```
wallet:{ownerType}:{ownerId}:balance_cents:locked → "1" if locked
```

#### checkout.session.completed (subscription + top-up)

```typescript
async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const metadata = session.metadata || {};

  if (metadata.type === 'subscription') {
    await createSubscription(session);
    return;
  }

  if (metadata.type === 'topup') {
    const amountCents = parseInt(metadata.amount_cents, 10);
    const currency = metadata.currency || 'USD';
    const userId = metadata.user_id;
    const orgId = metadata.organization_id;

    await walletService.addBalance({
      ownerId: userId || orgId,
      ownerType: userId ? 'user' : 'org',
      amountCents,
      currency,
      referenceType: 'stripe_session',
      referenceId: session.id,
    });
  }
}
```

#### invoice.paid (UPDATED: no "credit reset")

On renewal: update subscription period dates. Allowance resets daily via Redis TTL; no periodic wallet changes.

### 3.8 Seat Sync for B2B Plans

```typescript
async function onMembershipActivated(membership: Membership) {
  const org = await getOrganization(membership.organizationId);
  const subscription = await getOrgSubscription(org.id);
  if (!subscription || !subscription.stripeSubscriptionItemId) return;

  const activeSeats = await countActiveSeats(org.id);

  await seatSyncQueue.add('sync-seats', {
    organizationId: org.id,
    subscriptionItemId: subscription.stripeSubscriptionItemId,
    newQuantity: activeSeats,
  }, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  });
}
```

### 3.9 Top-up Packages & Pricing (UPDATED: money-based)

#### Option A: Stripe Products Only (Simpler)

```
$5 Top-up   → adds $5 wallet balance
$20 Top-up  → adds $20 wallet balance
$50 Top-up  → adds $50 wallet balance
```

Checkout metadata:

```typescript
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{ price: 'price_xxx', quantity: 1 }],
  metadata: {
    type: 'topup',
    amount_cents: '2000',
    currency: 'USD',
    user_id: userId,
    organization_id: orgId,
  },
});
```

#### Option B: Database Table (Flexible)

```prisma
model TopupPackage {
  id                 String    @id @default(uuid()) @db.Uuid
  name               String    @db.VarChar(255)
  description        String?
  
  amountCents        Int       @map("amount_cents") // money added to wallet
  priceCents         Int       @map("price_cents")  // Stripe charged
  currency           String    @default("USD") @db.VarChar(3)
  
  stripePriceId      String    @map("stripe_price_id") @db.VarChar(255)
  
  isActive           Boolean   @default(true) @map("is_active")
  isFeatured         Boolean   @default(false) @map("is_featured")
  sortOrder          Int       @default(0) @map("sort_order")
  
  minQuantity        Int       @default(1) @map("min_quantity")
  maxQuantity        Int       @default(10) @map("max_quantity")
  
  discountPercent    Int?      @map("discount_percent")
  originalPriceCents Int?      @map("original_price_cents")
  validUntil         DateTime? @map("valid_until")
  
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  @@map("topup_packages")
}
```

### 3.10 Deliverables Checklist

- [ ] Subscriptions table and CRUD
- [ ] wallet_balances table
- [ ] wallet_ledger (append-only)
- [ ] model_request_pricing table + admin management
- [ ] Redis wallet cache sync (DB is source of truth)
- [ ] BillingGuard Lua (atomic allowance-or-wallet)
- [ ] Refund wallet Lua (TTFB=0) + daily cap
- [ ] Stripe checkout session creation (subscription + top-up)
- [ ] Stripe webhook handler + idempotency (stripe_events table)
- [ ] Webhook retry queue (BullMQ) with retries + DLQ
- [ ] Seat sync on membership changes (B2B)
- [ ] Upstream key pooling and rotation

---

## Phase 4: Usage Metering & Dashboard

**Goal:** Track usage, calculate costs, and provide dashboard data.

### 4.1 Usage Tables (Prisma Schema)

```prisma
model RequestEvent {
  id              String   @id @default(uuid()) @db.Uuid
  requestId       String   @unique @map("request_id") @db.VarChar(255)
  
  userId          String?  @map("user_id") @db.Uuid
  organizationId  String?  @map("organization_id") @db.Uuid
  projectId       String?  @map("project_id") @db.Uuid
  apiKeyId        String?  @map("api_key_id") @db.Uuid
  
  model           String   @db.VarChar(255)
  providerRoute   String   @map("provider_route") @db.VarChar(50)
  endpoint        String   @db.VarChar(50)
  
  statusCode      Int?     @map("status_code")
  errorType       String?  @map("error_type") @db.VarChar(100)
  upstreamStatus  Int?     @map("upstream_status")
  
  latencyMsTotal  Int?     @map("latency_ms_total")
  latencyMsTtfb   Int?     @map("latency_ms_ttfb")
  
  bytesIn         Int?     @map("bytes_in")
  bytesOut        Int?     @map("bytes_out")
  
  tokensIn        Int?     @map("tokens_in")
  tokensOut       Int?     @map("tokens_out")
  
  pricingSnapshotId       String?  @map("pricing_snapshot_id") @db.Uuid
  computedEquivalentCost  Decimal? @map("computed_equivalent_cost") @db.Decimal(10, 6)
  
  // Billing fields (NEW)
  billingMode     String?  @map("billing_mode") @db.VarChar(20) // allowance | wallet
  chargedCents    Int      @default(0) @map("charged_cents")
  currency        String   @default("USD") @db.VarChar(3)
  
  createdAt       DateTime @default(now()) @map("created_at")

  // Relations
  user            User?            @relation(fields: [userId], references: [id])
  organization    Organization?    @relation(fields: [organizationId], references: [id])
  project         Project?         @relation(fields: [projectId], references: [id])
  apiKey          ApiKey?          @relation(fields: [apiKeyId], references: [id])
  pricingSnapshot PricingSnapshot? @relation(fields: [pricingSnapshotId], references: [id])

  @@index([userId, createdAt], map: "idx_request_events_user")
  @@index([organizationId, createdAt], map: "idx_request_events_org")
  @@index([apiKeyId, createdAt], map: "idx_request_events_key")
  @@index([model, createdAt], map: "idx_request_events_model")
  @@map("request_events")
}

model PricingSnapshot {
  id                      String    @id @default(uuid()) @db.Uuid
  model                   String    @db.VarChar(255)
  provider                String    @db.VarChar(50)
  inputPricePer1kTokens   Decimal   @map("input_price_per_1k_tokens") @db.Decimal(10, 6)
  outputPricePer1kTokens  Decimal   @map("output_price_per_1k_tokens") @db.Decimal(10, 6)
  effectiveFrom           DateTime  @map("effective_from")
  effectiveUntil          DateTime? @map("effective_until")
  createdAt               DateTime  @default(now()) @map("created_at")

  // Relation to RequestEvent
  requestEvents RequestEvent[]

  @@map("pricing_snapshots")
}

model UsageDaily {
  id                   String   @id @default(uuid()) @db.Uuid
  
  userId               String?  @map("user_id") @db.Uuid
  organizationId       String?  @map("organization_id") @db.Uuid
  
  date                 DateTime @db.Date
  
  totalRequests        Int      @default(0) @map("total_requests")
  successfulRequests   Int      @default(0) @map("successful_requests")
  failedRequests       Int      @default(0) @map("failed_requests")
  
  totalTokensIn        BigInt   @default(0) @map("total_tokens_in")
  totalTokensOut       BigInt   @default(0) @map("total_tokens_out")
  
  totalEquivalentCost  Decimal  @default(0) @map("total_equivalent_cost") @db.Decimal(12, 6)
  
  // Safe JSON default using dbgenerated for Postgres
  byModel              Json     @default(dbgenerated("'{}'::jsonb")) @map("by_model")
  
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  // Relations
  user         User?        @relation(fields: [userId], references: [id])
  organization Organization? @relation(fields: [organizationId], references: [id])

  @@unique([userId, date], map: "idx_usage_daily_user_date")
  @@unique([organizationId, date], map: "idx_usage_daily_org_date")
  @@map("usage_daily")
}
```

### 4.1.1 Request Events Partitioning (Raw SQL - Optional for MVP)

**NOTE:** Prisma does not manage table partitions natively. For the 90-day retention requirement,
partitions must be created and dropped via raw SQL or a cron job.

```sql
-- Option 1: Partition by month (recommended for high volume)
-- Run this BEFORE Prisma migrations (or in a separate setup script)

-- Create partitioned table (replace Prisma's auto-created table)
CREATE TABLE request_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(255) NOT NULL UNIQUE,
    user_id UUID,
    organization_id UUID,
    project_id UUID,
    api_key_id UUID,
    model VARCHAR(255) NOT NULL,
    provider_route VARCHAR(50) NOT NULL,
    endpoint VARCHAR(50) NOT NULL,
    status_code INT,
    error_type VARCHAR(100),
    upstream_status INT,
    latency_ms_total INT,
    latency_ms_ttfb INT,
    bytes_in INT,
    bytes_out INT,
    tokens_in INT,
    tokens_out INT,
    pricing_snapshot_id UUID,
    computed_equivalent_cost DECIMAL(10,6),
    billing_mode VARCHAR(20),
    charged_cents INT DEFAULT 0,
    currency VARCHAR(3) DEFAULT 'USD',
    created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE request_events_2026_01 PARTITION OF request_events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE request_events_2026_02 PARTITION OF request_events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- Cron job to create future partitions and drop old ones (> 90 days)
-- DROP TABLE request_events_2025_10;
```

**MVP Alternative:** Skip partitioning initially. Use scheduled DELETE:
```sql
DELETE FROM request_events WHERE created_at < NOW() - INTERVAL '90 days';
```

### 4.2 Usage Worker (BullMQ)

```typescript
interface RequestCompletedEvent {
  requestId: string;
  userId?: string;
  organizationId?: string;
  projectId?: string;
  apiKeyId: string;

  model: string;
  providerRoute: string;
  endpoint: string;

  statusCode: number;
  errorType?: string;
  upstreamStatus?: number;

  latencyMsTotal: number;
  latencyMsTtfb?: number;

  bytesIn: number;
  bytesOut: number;

  tokensIn?: number;
  tokensOut?: number;

  // Billing fields
  billingMode: 'allowance' | 'wallet';
  chargedCents: number;
  currency: string;

  timestamp: Date;

  isStreaming: boolean;
  streamStatus?: 'completed' | 'client_aborted' | 'upstream_error' | 'timeout';
}
```

### 4.3 Dashboard Queries (UPDATED savings)

```sql
-- Usage summary last 30 days
SELECT 
    date,
    total_requests,
    successful_requests,
    failed_requests,
    total_tokens_in,
    total_tokens_out,
    total_equivalent_cost
FROM usage_daily
WHERE user_id = $1
  AND date >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY date DESC;

-- Top models by usage
SELECT 
    model,
    COUNT(*) as request_count,
    SUM(tokens_in) as total_tokens_in,
    SUM(tokens_out) as total_tokens_out,
    SUM(computed_equivalent_cost) as total_cost
FROM request_events
WHERE user_id = $1
  AND created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY model
ORDER BY request_count DESC
LIMIT 10;

-- Savings = equivalent native cost - actual paid amount
SELECT
  SUM(re.computed_equivalent_cost) AS native_cost,
  SUM(re.charged_cents) / 100.0 AS paid_amount,
  SUM(re.computed_equivalent_cost) - (SUM(re.charged_cents) / 100.0) AS savings
FROM request_events re
WHERE re.user_id = $1
  AND re.created_at >= CURRENT_DATE - INTERVAL '30 days';
```

### 4.4 Deliverables Checklist

- [ ] request_events table (with billing fields)
- [ ] pricing_snapshots table
- [ ] usage_daily aggregates
- [ ] BullMQ usage worker
- [ ] Equivalent cost calc using pricing_snapshots
- [ ] Dashboard endpoints
- [ ] Savings calculation using charged_cents

---

## Phase 5: Admin & Self-Service

**Goal:** Admin panel APIs + user self-service endpoints.

### 5.1 Admin APIs (UPDATED)

```
POST   /admin/plans
GET    /admin/plans
PATCH  /admin/plans/:id
DELETE /admin/plans/:id

POST   /admin/models
GET    /admin/models
PATCH  /admin/models/:id
DELETE /admin/models/:id

# Model request pricing management
POST   /admin/model-pricing
GET    /admin/model-pricing
PATCH  /admin/model-pricing/:id

GET    /admin/users
GET    /admin/users/:id
PATCH  /admin/users/:id

# Wallet ops (optional, controlled)
POST   /admin/users/:id/wallet-adjustment

GET    /admin/organizations
GET    /admin/organizations/:id
PATCH  /admin/organizations/:id

GET    /admin/api-keys
DELETE /admin/api-keys/:id

GET    /admin/usage/overview
GET    /admin/audit-logs
```

### 5.2 Self-Service APIs (UPDATED)

```
# Auth
POST   /auth/register
POST   /auth/login
POST   /auth/verify-email
POST   /auth/forgot-password
POST   /auth/reset-password

# Profile
GET    /me
PATCH  /me

# Usage
GET    /me/usage
GET    /me/usage/daily

# Billing
GET    /me/billing/balance          # allowance remaining + wallet balance
GET    /me/wallet/ledger            # list wallet transactions
POST   /me/billing/checkout         # subscription checkout
POST   /me/billing/topup            # top-up checkout
GET    /me/billing/portal
GET    /me/billing/invoices

# API Keys
POST   /me/api-keys
GET    /me/api-keys
DELETE /me/api-keys/:id

# Organizations / Members / Projects
POST   /organizations
GET    /organizations
GET    /organizations/:id
PATCH  /organizations/:id
DELETE /organizations/:id

POST   /organizations/:id/members
GET    /organizations/:id/members
PATCH  /organizations/:id/members/:mid
DELETE /organizations/:id/members/:mid
POST   /invitations/:token/accept

POST   /organizations/:id/projects
GET    /organizations/:id/projects
PATCH  /projects/:id
DELETE /projects/:id

POST   /projects/:id/api-keys
GET    /projects/:id/api-keys
DELETE /projects/:id/api-keys/:kid

# Notifications
GET    /me/notifications/preferences
PATCH  /me/notifications/preferences
```

### 5.3 Audit Logs (Prisma Schema)

```prisma
model AuditLog {
  id           String   @id @default(uuid()) @db.Uuid
  
  actorType    String   @map("actor_type") @db.VarChar(50)
  actorId      String?  @map("actor_id") @db.Uuid
  
  action       String   @db.VarChar(100)
  resourceType String   @map("resource_type") @db.VarChar(100)
  resourceId   String?  @map("resource_id") @db.Uuid
  
  changes      Json?
  metadata     Json?
  ipAddress    String?  @map("ip_address")
  userAgent    String?  @map("user_agent")
  
  createdAt    DateTime @default(now()) @map("created_at")

  // Relations
  actor        User?    @relation("AuditLogActor", fields: [actorId], references: [id])

  @@index([actorId, createdAt], map: "idx_audit_logs_actor")
  @@index([resourceType, resourceId, createdAt], map: "idx_audit_logs_resource")
  @@index([action, createdAt], map: "idx_audit_logs_action")
  @@map("audit_logs")
}
```

### 5.4 Deliverables Checklist

- [ ] JWT authentication for dashboard
- [ ] User registration with email verification
- [ ] Admin role and permissions
- [ ] Admin APIs (including model request pricing)
- [ ] Self-service APIs (billing balance + ledger)
- [ ] Audit logging for sensitive actions
- [ ] Input validation on all endpoints

---

## Phase 6: Notifications & Polish

**Goal:** Email notifications and final polish.

### 6.1 Notification Preferences (Prisma Schema)

```prisma
model NotificationPreference {
  id                              String    @id @default(uuid()) @db.Uuid
  userId                          String    @unique @map("user_id") @db.Uuid
  
  emailLimitWarning               Boolean   @default(true) @map("email_limit_warning")
  emailPaymentFailed              Boolean   @default(true) @map("email_payment_failed")
  emailSubscriptionExpiring       Boolean   @default(true) @map("email_subscription_expiring")
  
  emailWeeklySummary              Boolean   @default(false) @map("email_weekly_summary")
  emailWeeklySummaryOptedInAt     DateTime? @map("email_weekly_summary_opted_in_at")
  emailWeeklySummaryOptInSource   String?   @map("email_weekly_summary_opt_in_source") @db.VarChar(100)
  
  emailProductUpdates             Boolean   @default(false) @map("email_product_updates")
  emailProductUpdatesOptedInAt    DateTime? @map("email_product_updates_opted_in_at")
  emailProductUpdatesOptInSource  String?   @map("email_product_updates_opt_in_source") @db.VarChar(100)
  
  unsubscribeToken                String    @default(uuid()) @map("unsubscribe_token") @db.VarChar(255)
  
  createdAt                       DateTime  @default(now()) @map("created_at")
  updatedAt                       DateTime  @updatedAt @map("updated_at")

  // Relations
  user                            User      @relation(fields: [userId], references: [id])

  @@index([unsubscribeToken], map: "idx_notification_prefs_unsubscribe")
  @@map("notification_preferences")
}
```

### 6.2 Email Templates

```
1. welcome
2. email_verification
3. password_reset
4. limit_warning
5. limit_exceeded
6. payment_failed
7. subscription_expiring
8. subscription_canceled
9. allowance_depleted        # renamed from credits_depleted
10. weekly_summary
11. member_invitation
```

### 6.3 Email Worker (BullMQ)

```typescript
interface EmailJob {
  template: string;
  to: string;
  subject: string;
  data: Record<string, any>;
}
```

### 6.4 Final Polish Checklist

- [ ] Email notification worker
- [ ] Email templates
- [ ] Notification preferences API
- [ ] Weekly summary job
- [ ] API documentation (OpenAPI/Swagger)
- [ ] Error messages review
- [ ] Security headers
- [ ] CORS configuration
- [ ] Request logging (without sensitive data)
- [ ] Load testing

---

## Database Schema

### Entity Relationship Diagram (UPDATED)

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│    users    │────▶│   memberships   │◀────│organizations│
└─────────────┘     └─────────────────┘     └─────────────┘
       │                                           │
       ▼                                           ▼
┌─────────────┐                            ┌─────────────┐
│  api_keys   │◀───────────────────────────│  projects   │
└─────────────┘                            └─────────────┘
       │
       ▼
┌─────────────────┐     ┌─────────────────┐
│ request_events  │────▶│pricing_snapshots│
└─────────────────┘     └─────────────────┘

┌─────────────┐     ┌─────────────────┐
│    plans    │◀────│  subscriptions  │
└─────────────┘     └─────────────────┘

┌─────────────────┐     ┌─────────────────┐
│ wallet_balances │◀────│  wallet_ledger  │
└─────────────────┘     └─────────────────┘

┌──────────────────────┐
│ model_request_pricing │
└──────────────────────┘

┌─────────────────┐     ┌─────────────────┐
│  model_catalog  │     │  stripe_events  │
└─────────────────┘     └─────────────────┘

┌─────────────────┐     ┌─────────────────────────┐
│   audit_logs    │     │notification_preferences │
└─────────────────┘     └─────────────────────────┘
```

### Tables Summary (UPDATED)

| Table | Purpose |
|-------|---------|
| users | User accounts |
| organizations | Workspaces/teams |
| memberships | User-org relationships |
| projects | Projects within orgs |
| api_keys | API authentication keys |
| plans | Plan definitions (daily allowance + limits) |
| subscriptions | Stripe subscriptions |
| wallet_balances | Current wallet money balance |
| wallet_ledger | Wallet transactions (append-only) |
| model_request_pricing | Request-based billing price per model |
| model_catalog | Available models |
| request_events | Raw request logs (incl. billing_mode + charged_cents) |
| pricing_snapshots | Historical token pricing for equivalent cost |
| usage_daily | Daily aggregates |
| stripe_events | Processed Stripe events |
| audit_logs | Admin action logs |
| notification_preferences | Email preferences |

---

## Redis Keys Strategy

### CRITICAL: ownerType Namespace (v1.7.2)

**Why required:** User UUIDs and Organization UUIDs can theoretically collide (both are UUIDv4). Without a namespace prefix, a user and org with the same UUID would share billing state.

**Rule:** ALL owner-scoped Redis keys MUST include `{ownerType}` prefix where `ownerType` = `'user'` or `'org'`

### Rate Limiting Keys

```
rl:{ownerType}:{ownerId}:m:{YYYYMMDDHHmm}    # e.g., rl:user:abc123:m:202601261430
rl:{ownerType}:{ownerId}:h:{YYYYMMDDHH}       # e.g., rl:org:xyz789:h:2026012614
rl:{ownerType}:{ownerId}:d:{YYYYMMDD}         # e.g., rl:user:abc123:d:20260126
```

### Concurrency Keys

```
conc:{ownerType}:{ownerId}                    # e.g., conc:user:abc123
conc:key:{keyId}                              # per-key (no ownerType needed)
conc:global                                   # global (no ownerType needed)
```

### Billing Keys (UPDATED v1.7.6 - Owner-Scoped Idempotency)

> ⚠️ **v1.7.6 SECURITY FIX:** All idempotency keys now include `ownerType:ownerId` to prevent
> cross-tenant collisions when clients provide their own `Idempotency-Key` header.

```
allow:used:{ownerType}:{ownerId}:{YYYYMMDD}         # daily allowance usage (TTL to UTC midnight)
wallet:{ownerType}:{ownerId}:balance_cents          # wallet cache (no TTL)

idem:billing:{ownerType}:{ownerId}:{requestId}      # billing idempotency (24h) - v1.7.6: owner-scoped
idem:refund:{ownerType}:{ownerId}:{requestId}       # refund idempotency (24h) - v1.7.6: owner-scoped
idem:response:{ownerType}:{ownerId}:{requestId}     # response cache (24h) - v1.7.6: owner-scoped
refund:{ownerType}:{ownerId}:{YYYYMMDD}             # refund count per day (TTL to midnight)
```

### Cache Keys

```
policy:user:{userId}
policy:org:{orgId}
apikey:{prefix}
models:all
models:{modelName}
pricing:{model}
```

### Cache Invalidation Rules

```typescript
async function onApiKeyRevoked(keyPrefix: string) {
  await redis.del(`apikey:${keyPrefix}`);
}

async function onUserPlanChanged(userId: string) {
  await redis.del(`policy:user:${userId}`);
}

async function onOrgPlanChanged(orgId: string) {
  await redis.del(`policy:org:${orgId}`);
}

async function onSubscriptionChanged(userId?: string, orgId?: string) {
  if (userId) await redis.del(`policy:user:${userId}`);
  if (orgId) await redis.del(`policy:org:${orgId}`);
}
```

---

## BigInt Safety (v1.7.6 CRITICAL)

Wallet balances can theoretically exceed JavaScript's `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991 = ~$90 trillion in cents).

> ⚠️ **v1.7.6 CLARIFICATION:** To ensure Lua's `tonumber()` comparison remains safe, we **enforce max wallet balance
> of 2^53-1 cents at ALL write paths** (top-up, refund, adjustment). This means `tonumber()` in Lua for comparison
> is safe because the value will never exceed JavaScript/Lua number precision limits.
> Mutations still use `INCRBY` for atomicity, but comparisons are safe with enforced max.

### Rules

1. **Prisma schema uses `BigInt`** for `balance_cents` and `amount_cents`
2. **Redis values are strings** - parse with `BigInt(String())`, not `BigInt()` directly
3. **Never convert BigInt to Number** for arithmetic in Node.js
4. **JSON serialization** requires `.toString()` since JSON doesn't support BigInt natively
5. **API responses** must return wallet balance as STRING, not number
6. **v1.7.6: MAX_BALANCE enforced at ALL write paths** - top-up, refund, adjustment all check max limit

### Code Patterns

```typescript
// ❌ WRONG - potential overflow
const balance = parseInt(redisValue || '0', 10);
const newBalance = balance - priceCents;

// ❌ RISKY - Node Redis may return number, BigInt(number) can lose precision
const newBalance = BigInt(await redis.incrby(walletKey, -amount));

// ✅ CORRECT - Always wrap with String() first
const newBalance = BigInt(String(await redis.incrby(walletKey, -amount)));

// ✅ CORRECT - BigInt throughout
const balance = BigInt(String(redisValue || '0'));
const newBalance = balance - BigInt(priceCents);
await redis.set(walletKey, newBalance.toString());

// ❌ WRONG - JSON.stringify fails on BigInt
const response = { wallet_balance_cents: walletBalance };

// ✅ CORRECT - convert to string for JSON (API standard)
const response = { wallet_balance_cents: walletBalance.toString() };
```

### v1.7.4 Critical: Node Redis INCRBY Return Type

Node Redis clients (`ioredis`, `redis`) may return INCRBY results as JavaScript `number`.
If the value exceeds 2^53-1, this causes silent precision loss.

**Always wrap with String() before BigInt conversion:**

```typescript
// ❌ RISKY - ioredis may return number type
const result = await redis.incrby(key, delta);
const balance = BigInt(result);  // If result is number > 2^53, precision lost!

// ✅ SAFE - String conversion handles both number and string returns
const result = await redis.incrby(key, delta);
const balance = BigInt(String(result));  // Always safe
```

### Prisma BigInt Handling

```typescript
// Reading from Prisma (already BigInt)
const wallet = await prisma.walletBalance.findUnique({ where: { userId } });
const balance: bigint = wallet.balanceCents; // Already BigInt

// Writing to Prisma
await prisma.walletBalance.update({
  where: { userId },
  data: { balanceCents: newBalance }, // Pass BigInt directly
});

// API Response serialization
return {
  balance_cents: wallet.balanceCents.toString(),
  // Or if you need a number for small values (use with caution):
  // balance_cents: Number(wallet.balanceCents) // Only if guaranteed < MAX_SAFE_INTEGER
};
```

---

## Idempotency Key Standard (v1.7.2)

### Request Identification

Every request needs a unique identifier for:
- Billing idempotency (prevent double-charge)
- Refund idempotency (prevent double-refund)
- Logging and tracing
- Client retry safety

### Header Priority

```typescript
function getRequestId(request: FastifyRequest): string {
  // Priority 1: Client-provided idempotency key (for explicit retry safety)
  const idempotencyKey = request.headers['idempotency-key'] as string;
  if (idempotencyKey && isValidIdempotencyKey(idempotencyKey)) {
    return idempotencyKey;
  }

  // Priority 2: Client-provided request ID (for tracing)
  const clientRequestId = request.headers['x-request-id'] as string;
  if (clientRequestId && isValidRequestId(clientRequestId)) {
    return clientRequestId;
  }

  // Priority 3: Generate new UUID
  return crypto.randomUUID();
}

function isValidIdempotencyKey(key: string): boolean {
  // Max 64 chars, alphanumeric + hyphen + underscore
  return /^[a-zA-Z0-9_-]{1,64}$/.test(key);
}

function isValidRequestId(id: string): boolean {
  // UUID format or similar
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}
```

### Response Headers

Always return the request ID in response:

```typescript
reply.header('x-request-id', requestId);
```

### Idempotency for Non-Streaming Requests

For non-streaming requests, clients can safely retry with the same `Idempotency-Key`:

```typescript
// Client sends:
POST /v1/chat/completions
Idempotency-Key: user-action-12345
Content-Type: application/json

// If request times out, client retries with SAME Idempotency-Key
// Server returns cached response if already processed
```

---

## Idempotency Replay Policy (v1.7.4 CRITICAL)

> ⚠️ **v1.7.3 CRITICAL FIX:** Previous versions had a vulnerability where the same `Idempotency-Key`
> could trigger unlimited upstream calls without additional billing. This section defines the correct behavior.
>
> ⚠️ **v1.7.4 UPDATE:** Added size limits for response caching to prevent memory abuse.

### The Problem

When a client retries with the same `Idempotency-Key`:
1. BillingGuard returns "already processed" (code 2) - ✅ No double-charge
2. BUT the request still proceeds to upstream - ❌ Unlimited free API calls!

### The Solution: Response Caching or 409 Conflict

#### Option A: Cache Response (Recommended for Non-Streaming)

For non-streaming requests, cache the full response:

```typescript
// Redis key: idem:response:{requestId}
// TTL: 24 hours (same as billing idempotency)
// MAX SIZE: 2MB (larger responses → 409 Conflict on replay)

const MAX_CACHEABLE_RESPONSE_SIZE = 2 * 1024 * 1024; // 2MB

interface IdempotencyCache {
  billingResult: 'allowance' | 'wallet';
  chargedCents: number;
  response?: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;  // JSON stringified
  };
  completedAt?: number;  // Unix timestamp
  bodyTruncated?: boolean;  // v1.7.4: true if response too large to cache
}

async function handleIdempotentRequest(
  ownerType: 'user' | 'org',  // v1.7.7: Added for owner-scoping
  ownerId: string,             // v1.7.7: Added for owner-scoping
  requestId: string,
  billingResult: BillingResult
): Promise<Response | null> {
  // v1.7.7 FIX: Response cache key MUST be owner-scoped to prevent cross-tenant collision
  // Previous: `idem:response:${requestId}` - VULNERABLE!
  // Now: Matches billing idempotency key format
  const cacheKey = `idem:response:${ownerType}:${ownerId}:${requestId}`;
  
  if (billingResult.code === 2) {  // Already processed
    const cached = await redis.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached) as IdempotencyCache;
      if (data.response) {
        // Return cached response
        return new Response(data.response.body, {
          status: data.response.statusCode,
          headers: {
            ...data.response.headers,
            'X-Idempotency-Replayed': 'true',
          },
        });
      }
    }
    // Billing says processed but no cached response - return 409
    throw new ConflictException({
      error: 'idempotency_conflict',
      message: 'Request already processed but response not available. Use a new Idempotency-Key.',
      request_id: requestId,
    });
  }
  
  return null;  // Proceed with normal request
}

// v1.7.6: Header whitelist for idempotency cache
// Only safe headers are cached - problematic headers are excluded
const CACHEABLE_HEADER_WHITELIST = new Set([
  'content-type',
  'x-request-id',
  'cache-control',
  // OpenAI-specific headers
  'openai-model',
  'openai-organization',
  'openai-processing-ms',
  'openai-version',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  // Anthropic-specific headers
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
  'request-id',
]);

// Headers that should NEVER be cached (security/correctness)
// - set-cookie: Session hijacking risk
// - transfer-encoding: Causes client parsing issues
// - content-length: Will be wrong for cached body
// - content-encoding: May cause decompression issues
// - connection: HTTP/1.1 connection management

function filterCacheableHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (CACHEABLE_HEADER_WHITELIST.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// After successful upstream response:
// v1.7.6: Now owner-scoped and with header whitelist
async function cacheIdempotentResponse(
  ownerType: 'user' | 'org',  // v1.7.6: Added
  ownerId: string,             // v1.7.6: Added
  requestId: string,
  billingMode: string,
  chargedCents: number,
  response: Response
): Promise<void> {
  // v1.7.6: Owner-scoped cache key
  const cacheKey = `idem:response:${ownerType}:${ownerId}:${requestId}`;
  const body = await response.clone().text();
  
  // v1.7.4: Check response size before caching
  const bodySize = Buffer.byteLength(body, 'utf8');
  
  const cache: IdempotencyCache = {
    billingResult: billingMode as 'allowance' | 'wallet',
    chargedCents,
    completedAt: Date.now(),
    bodyTruncated: bodySize > MAX_CACHEABLE_RESPONSE_SIZE,
  };
  
  // Only cache body if under size limit
  if (bodySize <= MAX_CACHEABLE_RESPONSE_SIZE) {
    cache.response = {
      statusCode: response.status,
      // v1.7.6: Filter headers through whitelist
      headers: filterCacheableHeaders(response.headers),
      body,
    };
  }
  
  await redis.setex(cacheKey, 86400, JSON.stringify(cache));
}
```

#### Handling Large Responses

If a response exceeds the cache size limit:
1. First request: Succeeds normally, `bodyTruncated: true` is stored
2. Retry with same key: Returns 409 Conflict (body not available)

```typescript
// In handleIdempotentRequest:
if (cached && cached.bodyTruncated && !cached.response) {
  throw new ConflictException({
    error: 'idempotency_conflict',
    message: 'Request processed but response too large to replay. Use a new Idempotency-Key.',
    request_id: requestId,
  });
}
```

#### Option B: Return 409 Conflict (For Streaming)

For streaming requests, caching the full response is impractical. Return 409:

```typescript
if (billingResult.code === 2 && isStreamingRequest) {
  throw new ConflictException({
    error: 'idempotency_conflict',
    message: 'Streaming request already processed. Use a new Idempotency-Key for retries.',
    request_id: requestId,
  });
}
```

### Decision Matrix

| Request Type | Idempotency Replay Behavior |
|--------------|----------------------------|
| Non-streaming | Cache response, return cached on replay |
| Streaming | Return 409 Conflict on replay |

### Implementation in Gateway Flow

```typescript
// In gateway handler, BEFORE proxying:
const billingResult = await billingGuard.charge(ctx);

if (billingResult.code === 2) {  // Idempotent hit
  if (ctx.isStreaming) {
    throw new ConflictException({
      error: 'idempotency_conflict',
      message: 'Streaming request already processed.',
    });
  }
  
  const cachedResponse = await getCachedResponse(ctx.requestId);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  // No cached response available
  throw new ConflictException({
    error: 'idempotency_conflict',
    message: 'Request processed but response unavailable.',
  });
}

// Proceed with upstream call...
```

---

## Synchronous Ledger Writes (v1.7.3 CRITICAL)

> ⚠️ **v1.7.3 CRITICAL FIX:** Financial data (wallet mutations) MUST be written synchronously to the database.
> Write-behind via queue risks data loss on crash.

### The Problem

Previous architecture suggested:
1. Charge wallet in Redis (hot path)
2. Queue event to BullMQ
3. Worker writes to `wallet_ledger` later

**Risk:** If the worker crashes or queue is lost, the ledger entry is never written.
This violates financial audit requirements.

### The Solution: Synchronous DB Transaction

All wallet mutations (charge, refund, top-up) MUST be written to the database **synchronously**
within the same request/transaction:

```typescript
@Injectable()
export class WalletService {
  constructor(
    private prisma: PrismaService,
    private redis: Redis,
  ) {}

  /**
   * Charge wallet - SYNCHRONOUS DB write (v1.7.6 - Single Mutation Point)
   * Called by BillingGuard when allowance is depleted
   *
   * ⚠️ **v1.7.6 CRITICAL FIX:** This method is called AFTER billing.lua has already
   * performed the Redis INCRBY. This method ONLY handles the DB write.
   * DO NOT mutate Redis here - that would cause double-charge!
   *
   * Flow:
   * 1. billing.lua does atomic check + INCRBY (Redis mutation)
   * 2. This method writes to DB (durability)
   * 3. If DB fails, caller (BillingGuard) must rollback Redis
   */
  async chargeWallet(params: {
    ownerType: 'user' | 'org';
    ownerId: string;
    amountCents: number;
    requestId: string;
    model: string;
    newBalanceFromLua: bigint;  // v1.7.6: Balance already updated by Lua
    currency?: string;
  }): Promise<{ success: boolean; newBalance: bigint }> {
    const { ownerType, ownerId, amountCents, requestId, model, newBalanceFromLua, currency = 'USD' } = params;
    
    // v1.7.6 FIX: NO Redis mutation here!
    // billing.lua already did: INCRBY wallet_key -price_cents
    // We only write to DB for durability
    
    // SYNCHRONOUS DB transaction (CRITICAL for durability)
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Update balance (DB is source of truth, sync with Lua's result)
        const wallet = await tx.walletBalance.update({
          where: ownerType === 'user'
            ? { userId: ownerId }
            : { organizationId: ownerId },
          data: {
            // v1.7.7 FIX: Prisma BigInt fields require BigInt() wrapper
            balanceCents: { decrement: BigInt(amountCents) },
            version: { increment: 1 },
          },
        });
        
        // Write ledger entry (append-only)
        await tx.walletLedger.create({
          data: {
            userId: ownerType === 'user' ? ownerId : null,
            organizationId: ownerType === 'org' ? ownerId : null,
            type: 'charge',
            amountCents: BigInt(-amountCents),  // Negative for charge
            balanceAfterCents: wallet.balanceCents,
            referenceType: 'request',
            referenceId: requestId,
            description: `API request charge: ${model}`,
            metadata: { model, requestId },
          },
        });
        
        return wallet;
      });
      
      return { success: true, newBalance: result.balanceCents };
    } catch (error) {
      // Caller (BillingGuard) must handle Redis rollback
      // by calling: redis.incrby(walletKey, +amountCents)
      throw error;
    }
  }

  /**
   * Refund wallet - SYNCHRONOUS DB write
   * Called on TTFB=0 upstream failure
   */
  async refundWallet(params: {
    ownerType: 'user' | 'org';
    ownerId: string;
    amountCents: number;
    requestId: string;
    reason: string;
  }): Promise<{ success: boolean; newBalance: bigint }> {
    const { ownerType, ownerId, amountCents, requestId, reason } = params;
    
    // 1. Check idempotency + daily cap in Redis (Lua script)
    const refundResult = await this.executeRefundLua(ownerType, ownerId, amountCents, requestId);
    
    if (refundResult[0] !== 1) {
      return {
        success: false,
        newBalance: BigInt(0),  // Caller should fetch actual balance if needed
      };
    }
    
    // 2. SYNCHRONOUS DB transaction
    // v1.7.7 FIX: DB transaction FIRST, then Redis INCRBY
    // If DB fails, no Redis mutation to worry about
    // If Redis fails after DB success, reconciliation fixes it
    const result = await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.walletBalance.update({
        where: ownerType === 'user'
          ? { userId: ownerId }
          : { organizationId: ownerId },
        data: {
          // v1.7.7 FIX: Prisma BigInt fields require BigInt() wrapper
          balanceCents: { increment: BigInt(amountCents) },
          version: { increment: 1 },
        },
      });
      
      await tx.walletLedger.create({
        data: {
          userId: ownerType === 'user' ? ownerId : null,
          organizationId: ownerType === 'org' ? ownerId : null,
          type: 'refund_upstream_failure',
          amountCents: amountCents,  // Positive for refund
          balanceAfterCents: wallet.balanceCents,
          referenceType: 'request',
          referenceId: requestId,
          description: `Refund: ${reason}`,
          metadata: { requestId, reason },
        },
      });
      
      return wallet;
    });
    
    return { success: true, newBalance: result.balanceCents };
  }

  /**
   * Top-up wallet - SYNCHRONOUS DB write (v1.7.6 - Race Condition Fix)
   * Called by Stripe webhook handler
   *
   * ⚠️ **v1.7.6 CRITICAL FIX:** Previous version used `redis.set()` which overwrites
   * any concurrent INCRBY operations (e.g., from BillingGuard charging).
   * Now uses `INCRBY` for Redis update to prevent race conditions.
   */
  async addBalance(params: {
    ownerType: 'user' | 'org';
    ownerId: string;
    amountCents: number;
    currency: string;
    referenceType: string;
    referenceId: string;
  }): Promise<{ newBalance: bigint }> {
    const { ownerType, ownerId, amountCents, currency, referenceType, referenceId } = params;
    
    // v1.7.6: Enforce max balance at ALL write paths (BigInt safety)
    const MAX_BALANCE = BigInt('9007199254740991');  // 2^53 - 1
    
    const result = await this.prisma.$transaction(async (tx) => {
      // First check current balance to enforce max BEFORE increment
      const currentWallet = await tx.walletBalance.findFirst({
        where: ownerType === 'user'
          ? { userId: ownerId }
          : { organizationId: ownerId },
      });
      
      const currentBalance = currentWallet?.balanceCents ?? 0n;
      const newBalance = currentBalance + BigInt(amountCents);
      
      // v1.7.6: Check max BEFORE write (prevents exceeding limit)
      if (newBalance > MAX_BALANCE) {
        throw new Error(`Wallet balance would exceed maximum allowed (${MAX_BALANCE}). Current: ${currentBalance}, Adding: ${amountCents}`);
      }
      
      const wallet = await tx.walletBalance.upsert({
        where: ownerType === 'user'
          ? { userId: ownerId }
          : { organizationId: ownerId },
        create: {
          userId: ownerType === 'user' ? ownerId : null,
          organizationId: ownerType === 'org' ? ownerId : null,
          balanceCents: BigInt(amountCents),
          currency,
        },
        update: {
          balanceCents: { increment: amountCents },
          version: { increment: 1 },
        },
      });
      
      await tx.walletLedger.create({
        data: {
          userId: ownerType === 'user' ? ownerId : null,
          organizationId: ownerType === 'org' ? ownerId : null,
          type: 'topup_purchase',
          amountCents: BigInt(amountCents),
          balanceAfterCents: wallet.balanceCents,
          referenceType,
          referenceId,
          description: `Top-up: ${amountCents / 100} ${currency}`,
        },
      });
      
      return wallet;
    });
    
    // v1.7.6 FIX: Use INCRBY instead of SET to prevent race condition!
    // If BillingGuard does INCRBY -X between DB write and this line,
    // SET would overwrite that decrement. INCRBY is atomic and additive.
    const redisKey = `wallet:${ownerType}:${ownerId}:balance_cents`;
    await this.redis.incrby(redisKey, amountCents);
    
    return { newBalance: result.balanceCents };
  }
}
```

### Key Principles

1. **Redis for speed, DB for durability**: Redis handles the hot-path check, but DB write is synchronous
2. **Ledger is append-only**: Never update or delete ledger entries
3. **Transaction wraps both**: Balance update + ledger entry in same transaction
4. **Rollback Redis on DB failure**: If DB transaction fails, restore Redis state

### What Goes to Queue (Async)

Only **non-financial** data goes to BullMQ for async processing:
- `request_events` (usage metrics)
- `usage_daily` aggregation
- Email notifications
- Audit logs (non-critical)

---

## Wallet Mutation Atomicity (v1.7.3)

> ⚠️ **v1.7.3 CRITICAL:** All wallet balance changes MUST go through a single mutation point
> to prevent race conditions between concurrent billing and top-up operations.

### The Problem

Concurrent operations can cause lost updates:

```
Time    Thread A (Billing)           Thread B (Top-up)
----    ------------------           -----------------
T1      Read balance: 1000
T2                                   Read balance: 1000
T3      Deduct 100 → 900
T4                                   Add 500 → 1500 (WRONG! Should be 1400)
T5      Write 900
T6                                   Write 1500 (Lost the deduction!)
```

### The Solution: INCRBY Only

All wallet mutations use Redis `INCRBY` (atomic increment/decrement):

```typescript
// ❌ WRONG - Read-Modify-Write race condition
const balance = await redis.get(walletKey);
const newBalance = parseInt(balance) - amount;
await redis.set(walletKey, newBalance);

// ✅ CORRECT - Atomic INCRBY
const newBalance = await redis.incrby(walletKey, -amount);
```

### Single Mutation Point Pattern

```typescript
@Injectable()
export class WalletMutationService {
  /**
   * ALL wallet mutations go through this single method
   * Ensures atomicity and consistency
   */
  async mutateBalance(params: {
    ownerType: 'user' | 'org';
    ownerId: string;
    deltaCents: number;  // Positive = add, Negative = deduct
    operation: 'charge' | 'refund' | 'topup' | 'adjustment';
    referenceId: string;
    metadata?: Record<string, any>;
  }): Promise<{ success: boolean; newBalance: bigint; previousBalance: bigint }> {
    const { ownerType, ownerId, deltaCents, operation, referenceId, metadata } = params;
    const redisKey = `wallet:${ownerType}:${ownerId}:balance_cents`;
    
    // For deductions, check balance first (atomic in Lua)
    if (deltaCents < 0) {
      const currentBalance = await this.redis.get(redisKey);
      const current = BigInt(currentBalance || '0');
      if (current + BigInt(deltaCents) < 0n) {
        return {
          success: false,
          newBalance: current,
          previousBalance: current
        };
      }
    }
    
    // Atomic mutation
    const newBalanceNum = await this.redis.incrby(redisKey, deltaCents);
    const newBalance = BigInt(newBalanceNum);
    const previousBalance = newBalance - BigInt(deltaCents);
    
    // Synchronous DB write (see Ledger Durability section)
    await this.writeToDatabase(ownerType, ownerId, deltaCents, newBalance, operation, referenceId, metadata);
    
    return { success: true, newBalance, previousBalance };
  }
}
```

### Concurrency Safety Matrix

| Operation | Redis Method | DB Transaction | Safe? |
|-----------|--------------|----------------|-------|
| Charge | `INCRBY -X` | Yes | ✅ |
| Refund | `INCRBY +X` | Yes | ✅ |
| Top-up | `INCRBY +X` | Yes | ✅ |
| Adjustment | `INCRBY ±X` | Yes | ✅ |
| Read balance | `GET` | No | ✅ (read-only) |

---

## Upstream Error Classification (v1.7.2)

### Error Types

Not all upstream errors should trigger the same response. Classify errors for appropriate handling:

```typescript
enum UpstreamErrorType {
  // Key-specific errors (don't trigger circuit breaker)
  KEY_INVALID = 'key_invalid',           // 401, 403 → disable this key
  KEY_RATE_LIMITED = 'key_rate_limited', // 429 → cool this key only

  // Provider errors (trigger circuit breaker)
  PROVIDER_ERROR = 'provider_error',     // 5xx → circuit breaker
  PROVIDER_OVERLOADED = 'provider_overloaded', // 503, 529 → circuit breaker

  // Network errors (trigger circuit breaker)
  NETWORK_TIMEOUT = 'network_timeout',   // connection/read timeout
  NETWORK_ERROR = 'network_error',       // DNS failure, connection refused

  // Client errors (no action needed)
  CLIENT_ERROR = 'client_error',         // 4xx (except 401, 403, 429)
}

function classifyUpstreamError(error: any, statusCode?: number): UpstreamErrorType {
  // Network errors
  if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
    return UpstreamErrorType.NETWORK_TIMEOUT;
  }
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    return UpstreamErrorType.NETWORK_ERROR;
  }

  // HTTP status-based classification
  if (statusCode) {
    if (statusCode === 401 || statusCode === 403) {
      return UpstreamErrorType.KEY_INVALID;
    }
    if (statusCode === 429) {
      return UpstreamErrorType.KEY_RATE_LIMITED;
    }
    if (statusCode === 503 || statusCode === 529) {
      return UpstreamErrorType.PROVIDER_OVERLOADED;
    }
    if (statusCode >= 500) {
      return UpstreamErrorType.PROVIDER_ERROR;
    }
    if (statusCode >= 400) {
      return UpstreamErrorType.CLIENT_ERROR;
    }
  }

  return UpstreamErrorType.PROVIDER_ERROR; // Default to provider error
}
```

### Error Handling Actions

```typescript
async function handleUpstreamError(
  error: any,
  errorType: UpstreamErrorType,
  provider: string,
  keyId?: string
): Promise<void> {
  switch (errorType) {
    case UpstreamErrorType.KEY_INVALID:
      // Disable this specific key
      if (keyId) {
        await upstreamKeyService.disableKey(keyId, 'invalid_credentials');
        logger.error('Upstream key disabled due to auth failure', { keyId, provider });
      }
      break;

    case UpstreamErrorType.KEY_RATE_LIMITED:
      // Cool this key only (don't affect circuit breaker)
      if (keyId) {
        await upstreamKeyService.markKeyCooling(keyId, 60_000); // 1 minute
        logger.warn('Upstream key rate limited, cooling', { keyId, provider });
      }
      // Do NOT record failure to circuit breaker
      break;

    case UpstreamErrorType.PROVIDER_ERROR:
    case UpstreamErrorType.PROVIDER_OVERLOADED:
    case UpstreamErrorType.NETWORK_TIMEOUT:
    case UpstreamErrorType.NETWORK_ERROR:
      // Record failure to circuit breaker
      await circuitBreaker.recordFailure(provider);
      logger.error('Upstream provider error', { errorType, provider });
      break;

    case UpstreamErrorType.CLIENT_ERROR:
      // No action - client's fault
      break;
  }
}
```

### Key Cooling vs Circuit Breaker

| Scenario | Key Cooling | Circuit Breaker |
|----------|-------------|-----------------|
| 401/403 (auth failure) | Disable key permanently | No |
| 429 (rate limit) | Cool key 1-5 minutes | No |
| 5xx (server error) | No | Yes, record failure |
| Timeout | No | Yes, record failure |
| DNS/Connection failure | No | Yes, record failure |

### Refund Eligibility

Only certain error types qualify for wallet refund (TTFB=0):

```typescript
function isRefundEligible(errorType: UpstreamErrorType, ttfbMs: number | null): boolean {
  // Must have TTFB = 0 or null (no data received)
  if (ttfbMs !== null && ttfbMs > 0) {
    return false;
  }

  // Only provider/network errors qualify
  return [
    UpstreamErrorType.PROVIDER_ERROR,
    UpstreamErrorType.PROVIDER_OVERLOADED,
    UpstreamErrorType.NETWORK_TIMEOUT,
    UpstreamErrorType.NETWORK_ERROR,
  ].includes(errorType);
}
```

---

## API Endpoints Reference

### Public API (OpenAI-Compatible)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /v1/chat/completions | Chat completion (stream/non-stream) |
| POST | /v1/embeddings | Generate embeddings |
| GET | /v1/models | List available models |

### `/v1/models` Response Format (v1.7.5)

The models endpoint returns OpenAI-compatible format with additional capabilities metadata:

```typescript
interface ModelListResponse {
  object: 'list';
  data: Model[];
}

interface Model {
  id: string;                    // e.g., "gpt-4-turbo"
  object: 'model';
  created: number;               // Unix timestamp
  owned_by: string;              // e.g., "openai", "anthropic", "google"
  
  // v1.7.5: Explicit capabilities field for SDK discovery
  capabilities: ModelCapabilities;
  
  // Optional metadata
  deprecation?: {
    deprecated_at: string;       // ISO date
    replacement_model?: string;
  };
}

interface ModelCapabilities {
  // Core capabilities
  chat: boolean;                 // Supports /v1/chat/completions
  embeddings: boolean;           // Supports /v1/embeddings
  images: boolean;               // Supports image input (vision)
  
  // Feature flags
  function_calling: boolean;     // Supports tools/function calling
  json_mode: boolean;            // Supports response_format: { type: "json_object" }
  streaming: boolean;            // Supports stream: true
  
  // Context limits
  max_input_tokens: number;      // Maximum input context
  max_output_tokens: number;     // Maximum output tokens
  
  // Optional advanced features
  parallel_tool_calls?: boolean; // Supports multiple tool calls per response
  system_message?: boolean;      // Supports system messages
}
```

**Example Response:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4-turbo",
      "object": "model",
      "created": 1706745600,
      "owned_by": "openai",
      "capabilities": {
        "chat": true,
        "embeddings": false,
        "images": true,
        "function_calling": true,
        "json_mode": true,
        "streaming": true,
        "max_input_tokens": 128000,
        "max_output_tokens": 4096,
        "parallel_tool_calls": true,
        "system_message": true
      }
    },
    {
      "id": "claude-3-5-sonnet",
      "object": "model",
      "created": 1706745600,
      "owned_by": "anthropic",
      "capabilities": {
        "chat": true,
        "embeddings": false,
        "images": true,
        "function_calling": true,
        "json_mode": false,
        "streaming": true,
        "max_input_tokens": 200000,
        "max_output_tokens": 8192,
        "parallel_tool_calls": false,
        "system_message": true
      }
    },
    {
      "id": "text-embedding-3-large",
      "object": "model",
      "created": 1706745600,
      "owned_by": "openai",
      "capabilities": {
        "chat": false,
        "embeddings": true,
        "images": false,
        "function_calling": false,
        "json_mode": false,
        "streaming": false,
        "max_input_tokens": 8191,
        "max_output_tokens": 0
      }
    }
  ]
}
```

**Implementation Notes:**
- Capabilities are stored in `model_catalog.capabilities` JSON column
- SDK clients can discover model features programmatically
- Filter models by capability: `GET /v1/models?capability=function_calling`

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Liveness check |
| GET | /health/ready | Readiness check |

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /auth/register | Register user |
| POST | /auth/login | Login |
| POST | /auth/verify-email | Verify email |
| POST | /auth/forgot-password | Request reset |
| POST | /auth/reset-password | Reset password |

### Self-Service (requires JWT)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /me | Get profile |
| PATCH | /me | Update profile |
| GET | /me/usage | Usage summary |
| GET | /me/billing/balance | Daily allowance remaining + wallet balance |
| GET | /me/wallet/ledger | Wallet transactions |
| POST | /me/api-keys | Create API key |
| GET | /me/api-keys | List my API keys |
| DELETE | /me/api-keys/:id | Revoke API key |
| POST | /me/billing/checkout | Start subscription |
| POST | /me/billing/topup | Top-up wallet |
| GET | /me/billing/portal | Stripe portal URL |
| GET | /me/billing/invoices | List invoices |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /webhooks/stripe | Stripe webhook |

---

## Environment Variables

```bash
# Application
NODE_ENV=production
PORT=3000
API_BASE_URL=https://api.omniway.ai

# Database
DATABASE_URL=postgresql://user:pass@host:5432/omniway
DATABASE_POOL_SIZE=20

# Redis
REDIS_URL=redis://host:6379
REDIS_PASSWORD=

# Upstream Providers
UPSTREAM_OPENAI_URL=https://api.o7.team/openai
UPSTREAM_OPENAI_KEY=sk-xxx
UPSTREAM_ANTHROPIC_URL=https://api.o7.team/anthropic
UPSTREAM_ANTHROPIC_KEY=sk-xxx
UPSTREAM_OPENAI_COMPATIBLE_URL=https://api.o7.team/openai-compatible
UPSTREAM_OPENAI_COMPATIBLE_KEY=sk-xxx

# Multi-key mode (optional)
UPSTREAM_KEY_SOURCE=database  # 'env' or 'database'
UPSTREAM_KEY_ENCRYPTION_KEY=base64-encoded-32-bytes

# Stripe
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxx

# JWT
JWT_SECRET=your-256-bit-secret
JWT_EXPIRES_IN=7d

# Email
EMAIL_PROVIDER=console
EMAIL_FROM=noreply@omniway.ai

# Rate Limiting Defaults
DEFAULT_REQUESTS_PER_MINUTE=20
DEFAULT_REQUESTS_PER_HOUR=100
DEFAULT_REQUESTS_PER_DAY=500
DEFAULT_MAX_CONCURRENT=10

# Billing
BILLING_TIMEZONE=UTC
WALLET_DEFAULT_CURRENCY=USD
REFUND_DAILY_CAP=10

# Security
API_KEY_PREFIX=sk_live_
API_KEY_PEPPER=your-32-byte-random-pepper
CORS_ORIGINS=https://omniway.ai,https://app.omniway.ai

# Observability
LOG_LEVEL=info
LOG_FORMAT=json
```

---

## Deployment Guide

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis 7+
- Stripe account

### Local Development

```bash
docker-compose up -d
pnpm install
npx prisma migrate dev
npx prisma db seed
pnpm run start:dev
pnpm run worker:dev
```

### Production Deployment

```bash
pnpm run build
npx prisma migrate deploy
NODE_ENV=production node dist/main.js
NODE_ENV=production node dist/workers/main.js
```

### Kubernetes Considerations

- Deploy API and Worker separately
- HPA for API
- Separate Redis/Postgres (managed recommended)
- readiness/liveness probes
- graceful shutdown

### Upstream HTTP Client Configuration (undici)

```typescript
import { Agent, setGlobalDispatcher } from 'undici';

const upstreamAgent = new Agent({
  connections: 100,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  headersTimeout: 30_000,
  bodyTimeout: 300_000,
  connect: { timeout: 5_000 },
  allowH2: false,
});

setGlobalDispatcher(upstreamAgent);
```

---

## Implementation Priority

### Week 1-2: Phase 1 + Phase 2 (Core)
- Project setup
- Prisma schema + migrations
- API key auth
- Rate limiting
- Basic proxy (OpenAI only)

### Week 3: Phase 2 (Complete) + Phase 3 (Start)
- Anthropic transformation
- Streaming support
- Stripe integration start

### Week 4: Phase 3 (Complete)
- Wallet + ledger
- Allowance-or-wallet billing
- Top-up flow

### Week 5: Phase 4
- Usage tracking
- Dashboard APIs
- Equivalent cost calculation

### Week 6: Phase 5 + Phase 6
- Admin APIs
- Self-service APIs
- Email notifications
- Polish and testing

---

## Notes & Assumptions

1. **Single Region v1**: No multi-region support initially.

2. **No Automatic Fallback**: Provider down → request fails (optional future fallback per model).

3. **Billing at Start**: Allowance increment OR wallet charge at request start.

4. **UTC Timestamps**: All timestamps in UTC. Allowance resets at UTC midnight.

5. **No Prompt Logging**: Request/response content not logged by default.

6. **Provider capacity**: You may buy upstream request quotas (e.g., 100k/day). Omniway enforces downstream daily allowance + wallet billing; upstream quotas are operational capacity constraints, not directly exposed to users.

7. **Equivalent cost**: Pricing snapshots can be manually updated. Used only for analytics/savings.

---

## Legal Considerations (v1.7.5)

### ⚠️ Upstream Provider Reselling Permission

**CRITICAL:** Before launching Omniway.ai as a commercial service, verify that your upstream provider agreements permit reselling/white-labeling:

| Provider | Key Terms to Review |
|----------|-------------------|
| **o7.team (your provider)** | Explicit reselling clause, volume pricing tier, SLA terms |
| **OpenAI (if direct)** | Usage Policies Section 2.b - Commercial use permitted but check "aggregate data" and "competing products" clauses |
| **Anthropic (if direct)** | Usage Policy - Commercial API usage generally allowed, but verify redistribution |
| **Google (if direct)** | Gemini API Terms - Check "Downstream Products" and "Sub-licensing" sections |

### Required Legal Documentation

Before production launch, ensure you have:

1. **Service Agreement with Upstream Provider**
   - Written permission for API reselling/redistribution
   - Volume pricing and commitment terms
   - SLA guarantees (uptime, latency)
   - Data processing agreement (DPA)

2. **Your Terms of Service (for Omniway users)**
   - Acceptable use policy
   - Rate limits and fair use
   - Data retention and privacy
   - Liability limitations

3. **Privacy Policy**
   - GDPR compliance (if serving EU users)
   - Data minimization practices
   - Subprocessor list (including upstream providers)

4. **Data Processing Addendum (DPA)**
   - Required for B2B/enterprise customers
   - Standard Contractual Clauses for international transfer

### Compliance Checklist

- [ ] Upstream provider written reselling permission obtained
- [ ] Terms of Service drafted and reviewed by legal
- [ ] Privacy Policy compliant with target markets (GDPR, CCPA)
- [ ] DPA template ready for B2B customers
- [ ] SOC 2 Type I roadmap (recommended for enterprise sales)
- [ ] Business insurance (E&O, Cyber liability)

### Risk Mitigation

If upstream provider changes terms or revokes access:

1. **Contractual Protection**: Negotiate minimum notice period (e.g., 90 days) for any changes
2. **Multi-Provider Strategy**: Consider adding backup providers (direct OpenAI, Anthropic)
3. **Communication Plan**: Have customer notification templates ready
4. **Escrow/Reserves**: Maintain enough reserves to refund prepaid credits if needed

---

## Critical Implementation Notes

### UTC Midnight TTL Calculation (CRITICAL for Billing Lua)

The `day_ttl_sec` parameter in BillingGuard Lua must be calculated correctly for UTC midnight reset:

```typescript
/**
 * Calculate seconds until UTC midnight (00:00:00 UTC next day)
 * This is CRITICAL for daily allowance TTL
 */
function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDate = now.getUTCDate();

  // Next UTC midnight
  const nextMidnight = new Date(Date.UTC(utcYear, utcMonth, utcDate + 1, 0, 0, 0));
  const diffMs = nextMidnight.getTime() - now.getTime();
  
  // Minimum 1 second to avoid edge cases
  return Math.max(1, Math.floor(diffMs / 1000));
}

// Usage in BillingGuard
const dayTtlSec = secondsUntilUtcMidnight();
// v1.7.6: Owner-scoped idempotency key
const result = await redis.evalsha(
  BILLING_LUA_SHA,
  3,
  `allow:used:${ownerType}:${ownerId}:${getUtcDateString()}`,  // v1.7.3 FIX: Include ownerType
  `wallet:${ownerType}:${ownerId}:balance_cents`,              // v1.7.3 FIX: Include ownerType
  `idem:billing:${ownerType}:${ownerId}:${requestId}`,         // v1.7.6 FIX: Owner-scoped idempotency
  dailyAllowance,
  priceCents,
  requestId,
  86400, // idempotency TTL
  dayTtlSec // calculated TTL until UTC midnight
);

/**
 * Get current UTC date as YYYYMMDD string
 */
function getUtcDateString(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const date = String(now.getUTCDate()).padStart(2, '0');
  return `${year}${month}${date}`;
}
```

### Concurrency Slot Release Guarantee

Every request MUST release its concurrency slot on ALL exit paths:

```typescript
async function handleRequest(req, res) {
  const requestId = generateRequestId();
  let concurrencyAcquired = false;

  try {
    const acquired = await acquireConcurrencySlot(userId, requestId);
    if (!acquired) return res.status(429).send({ error: 'Too many concurrent requests' });
    concurrencyAcquired = true;

    // ... rest ...
  } finally {
    if (concurrencyAcquired) {
      await releaseConcurrencySlot(userId, requestId);
    }
  }
}

req.on('close', async () => {
  if (concurrencyAcquired) {
    await releaseConcurrencySlot(userId, requestId);
    upstreamRequest?.destroy();
  }
});
```

### Wallet Cache Reconciliation (Recommended)

DB is source of truth; Redis is hot cache. Run daily (or hourly) reconciliation:

```typescript
// v1.7.4 FIX: Include ownerType in Redis key (CRITICAL!)
async function reconcileWallet(ownerId: string, ownerType: 'user' | 'org') {
  const dbBalance = await prisma.walletBalance.findFirst({
    where: ownerType === 'user' ? { userId: ownerId } : { organizationId: ownerId },
  });
  
  // v1.7.4 FIX: ownerType MUST be included to prevent user/org UUID collision
  const redisKey = `wallet:${ownerType}:${ownerId}:balance_cents`;
  const redisVal = await redis.get(redisKey);
  
  // v1.7.4 FIX: Use BigInt(String()) pattern for safety
  const redisBalance = BigInt(String(redisVal || '0'));

  if (dbBalance && redisBalance !== dbBalance.balanceCents) {
    logger.warn('Wallet mismatch detected', {
      ownerId,
      ownerType,
      db: dbBalance.balanceCents.toString(),  // BigInt → string for logging
      redis: redisBalance.toString(),
    });
    await redis.set(redisKey, dbBalance.balanceCents.toString());
  }
}

// =====================================================
// v1.7.7 NEW: Redis Wallet Cold Start Bootstrap
// =====================================================

/**
 * Bootstrap wallet balance in Redis if missing (cold start scenario)
 *
 * PROBLEM: If Redis is flushed or wallet key expires/missing, BillingGuard's Lua script
 * sees balance as 0 and returns 402 even if DB has balance.
 *
 * SOLUTION: Check Redis on policy load, bootstrap from DB if missing.
 *
 * WHEN TO CALL: During AuthGuard policy load, or at BillingGuard entry.
 */
async function bootstrapWalletIfMissing(ownerType: 'user' | 'org', ownerId: string): Promise<void> {
  const walletKey = `wallet:${ownerType}:${ownerId}:balance_cents`;
  
  // Check if Redis key exists
  const exists = await redis.exists(walletKey);
  if (exists) {
    return; // Already bootstrapped
  }
  
  // Load from DB
  const dbWallet = await prisma.walletBalance.findFirst({
    where: ownerType === 'user'
      ? { userId: ownerId }
      : { organizationId: ownerId },
  });
  
  if (dbWallet) {
    // Use SETNX to avoid race condition with concurrent bootstraps
    // SETNX = SET if Not eXists (atomic)
    await redis.setnx(walletKey, dbWallet.balanceCents.toString());
    
    logger.info('Wallet bootstrapped from DB', {
      ownerType,
      ownerId,
      balanceCents: dbWallet.balanceCents.toString(),
    });
  } else {
    // No wallet in DB - user will use allowance first, wallet created on first top-up
    logger.debug('No wallet found in DB for bootstrap', { ownerType, ownerId });
  }
}

/**
 * Enhanced policy load with wallet bootstrap
 * Call this in AuthGuard after loading user/org policy
 */
async function loadPolicyWithWalletBootstrap(
  ownerType: 'user' | 'org',
  ownerId: string
): Promise<PolicyData> {
  // 1. Load policy from cache or DB
  const policy = await loadPolicy(ownerType, ownerId);
  
  // 2. Bootstrap wallet if needed (v1.7.7)
  await bootstrapWalletIfMissing(ownerType, ownerId);
  
  return policy;
}
```

---

## Request Context Interface (v1.7.2)

Standardized request context passed through guards and handlers:

```typescript
interface RequestContext {
  // Identity
  requestId: string;
  idempotencyKey?: string;

  // Owner (user or org)
  ownerType: 'user' | 'org';
  ownerId: string;

  // API Key
  apiKeyId: string;
  apiKeyPrefix: string;

  // Plan & Limits
  plan: {
    id: string;
    name: string;
    dailyAllowanceRequests: number;
    requestsPerMinute: number | null;
    requestsPerHour: number | null;
    requestsPerDay: number | null;
    maxConcurrentRequests: number;
    maxRequestBodyBytes: number;
    maxStreamDurationSeconds: number;
    allowedModels: string[] | null;
    allowTopup: boolean;
  };

  // Project (optional, for org keys)
  projectId?: string;

  // Resolved after ModelResolver
  model?: string;
  providerRoute?: string;
  providerModelId?: string;

  // Resolved after BillingGuard
  billingMode?: 'allowance' | 'wallet';
  pricing?: {
    priceCents: number;
    currency: string;
    pricingSnapshotId?: string;
  };

  // Timing
  startTime: number;
  ttfbMs?: number;

  // Upstream
  upstreamKeyId?: string;
  upstreamStatus?: number;
}

// Attach to Fastify request
declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}
```

---

## PR/Sprint Plan (v1.7.2)

### Sprint 1: MVP Core (6 PRs)

#### PR-0: Bootstrap
**Scope:** Project setup, no business logic

- [ ] NestJS + Fastify adapter
- [ ] Docker Compose (Postgres, Redis)
- [ ] Prisma schema (all tables)
- [ ] Raw SQL migration for partial indexes + check constraints
- [ ] Config module with env validation
- [ ] Structured JSON logging (pino)
- [ ] Health endpoints (`/health`, `/health/ready`)
- [ ] Graceful shutdown

**Tests:** Health check integration test

---

#### PR-1: Auth + Policy Load
**Scope:** API key auth and policy caching

- [ ] API key generation (hash + prefix)
- [ ] API key validation guard
- [ ] Policy load from DB (user/org + plan)
- [ ] Redis policy cache with invalidation
- [ ] RequestContext interface
- [ ] `x-request-id` / `Idempotency-Key` extraction

**Tests:**
- API key generation/verification unit tests
- Auth guard integration tests
- Policy cache hit/miss tests

---

#### PR-2: RateLimit + Concurrency
**Scope:** Redis Lua scripts for rate limiting

- [ ] Rate limit Lua script (minute/hour/day)
- [ ] Concurrency limit Lua script (acquire/release)
- [ ] RateLimitGuard
- [ ] ConcurrencyGuard
- [ ] Proper 429 response with `Retry-After` header
- [ ] `X-RateLimit-*` response headers

**Tests:**
- Lua script unit tests (redis-mock or testcontainers)
- Rate limit guard integration tests
- Concurrency slot release guarantee test

---

#### PR-3: Gateway Proxy (OpenAI route only)
**Scope:** Basic proxy without billing

- [ ] Model catalog table + seed
- [ ] ModelResolver middleware
- [ ] ModelAccessGuard
- [ ] OpenAI proxy (non-streaming first)
- [ ] OpenAI streaming (SSE)
- [ ] Error transformation to OpenAI format
- [ ] Upstream timeout handling
- [ ] Circuit breaker Lua script
- [ ] Upstream error classification

**Tests:**
- Model resolution tests
- Proxy integration test (mock upstream)
- Streaming test
- Circuit breaker state machine tests

---

#### PR-4: Billing v1 (Allowance-or-Wallet)
**Scope:** Core billing without Stripe

- [ ] WalletBalance + WalletLedger tables
- [ ] ModelRequestPricing table
- [ ] Billing Lua script (atomic allowance-or-wallet)
- [ ] BillingGuard
- [ ] Wallet service (add balance, deduct, get balance)
- [ ] Redis wallet cache sync
- [ ] BigInt safety throughout
- [ ] ownerType namespace in all Redis keys

**Tests:**
- Billing Lua script edge cases
- Allowance depletion → wallet fallback
- Insufficient wallet → 402
- Idempotency (same requestId = same result)
- BigInt overflow test

---

#### PR-5: Streaming + TTFB + Refund
**Scope:** Streaming metrics and refund logic

- [ ] TTFB measurement (streaming & non-streaming)
- [ ] Refund Lua script (daily cap + idempotency)
- [ ] Refund on TTFB=0 upstream failure
- [ ] Stream abort handling
- [ ] Concurrency slot release on stream end/abort

**Tests:**
- TTFB measurement accuracy
- Refund eligibility logic
- Daily refund cap enforcement
- Refund idempotency

---

#### PR-6: Worker + Persistence
**Scope:** BullMQ workers for async tasks

- [ ] BullMQ setup
- [ ] RequestCompleted event schema
- [ ] Usage worker (batch insert to request_events)
- [ ] Wallet ledger write-behind (DB sync)
- [ ] Usage daily aggregation job
- [ ] PricingSnapshot management

**Tests:**
- Worker job processing tests
- Batch insert correctness
- Aggregation accuracy

---

### Sprint 2: Stripe + Dashboard

#### PR-7: Stripe Subscriptions
- [ ] Stripe checkout session creation
- [ ] Webhook handler + idempotency
- [ ] Subscription lifecycle (create, update, cancel)
- [ ] Plan↔Stripe price mapping

#### PR-8: Stripe Top-up
- [ ] Top-up packages table
- [ ] Top-up checkout flow
- [ ] Wallet credit on successful payment

#### PR-9: Dashboard APIs
- [ ] Usage summary endpoint
- [ ] Savings calculation
- [ ] Wallet balance + ledger endpoints
- [ ] API key management endpoints

---

### Sprint 3: Admin + Polish

#### PR-10: Admin APIs
- [ ] Plan CRUD
- [ ] Model CRUD
- [ ] Model pricing management
- [ ] User/org management
- [ ] Wallet adjustments

#### PR-11: Organizations + Seats
- [ ] Org CRUD
- [ ] Membership management
- [ ] Invitation flow
- [ ] Seat sync with Stripe

#### PR-12: Notifications
- [ ] Email worker
- [ ] Email templates
- [ ] Notification preferences

---

### Definition of Done (per PR)

- [ ] All code reviewed
- [ ] Unit tests passing (>80% coverage for new code)
- [ ] Integration tests passing
- [ ] No TypeScript errors
- [ ] Prisma migrations applied cleanly
- [ ] Redis scripts tested
- [ ] API documentation updated
- [ ] No security vulnerabilities (npm audit)

---

### Migration Order Note (v1.7.3)

> ⚠️ **CRITICAL:** The raw SQL migration for partial indexes and check constraints (section 1.5)
> references tables like `api_keys`, `subscriptions`, `wallet_balances`, and `wallet_ledger`.
> These tables are defined in later phases (Phase 2, Phase 3).
>
> **Solution:** Create the constraints migration as a separate migration file that runs AFTER
> all tables are created. The recommended order:
>
> 1. `001_initial_schema` - All tables from Prisma schema
> 2. `002_constraints_indexes` - Partial unique indexes + XOR check constraints
>
> Alternatively, run `npx prisma migrate dev` for the base schema first, then create
> the constraints migration with `npx prisma migrate dev --create-only --name constraints`.

---

## Recommended Test Scenarios (v1.7.7 UPDATED)

### Billing / Wallet Tests

| Test | Expected Outcome |
|------|------------------|
| Same requestId with 100 parallel retries | Single charge, others get cached response or 409 |
| Allowance: last 1 request + 50 parallel | Exactly one succeeds with allowance, others fail or use wallet |
| Wallet balance at edge (price-1, price, price+1) | Correct 402/charge behavior |
| DB commit failure simulation | Redis rollback successful |

### v1.7.7 NEW: Cross-Tenant Security Tests

| Test | Expected Outcome |
|------|------------------|
| **Cross-tenant idempotency** - User A and User B send same `Idempotency-Key` | Each gets their own billing/response, no collision |
| **Cross-tenant response cache** - User A's cached response not returned to User B | 404 or fresh request for User B |
| **Org/User UUID collision** - Same UUID as user and org | Separate Redis keys due to ownerType prefix |

### v1.7.7 NEW: Double-Mutate Prevention Tests

| Test | Expected Outcome |
|------|------------------|
| **Top-up + charge race** - Simultaneous top-up and charge | Both operations atomic, final balance = initial + topup - charge |
| **Multiple concurrent top-ups** - 10 parallel $10 top-ups | Final balance = initial + $100 (no lost updates) |
| **Refund during charge** - Charge and refund for different requests | Both succeed independently |

### v1.7.7 NEW: Redis Cold Start Tests

| Test | Expected Outcome |
|------|------------------|
| **Redis empty, DB has balance** - First request after Redis flush | Bootstrap loads DB balance, request succeeds |
| **Redis empty, DB has no wallet** - New user first request | Wallet created, allowance used first |
| **Partial Redis state** - Rate limit keys exist, wallet key missing | Wallet bootstrapped, rate limits preserved |

### v1.7.7 NEW: Refund Abuse Prevention Tests

| Test | Expected Outcome |
|------|------------------|
| **TTFB=0 refund** - Upstream fails before any data | Refund granted |
| **TTFB>0 refund attempt** - Upstream sends partial data then fails | No refund (TTFB check) |
| **Daily refund cap** - 11 refund attempts in one day (cap=10) | First 10 succeed, 11th rejected |
| **Duplicate refund** - Same requestId refund twice | Second attempt returns `already_refunded` |

### Streaming Tests

| Test | Expected Outcome |
|------|------------------|
| Client abort (socket close) | Concurrency slot released + upstream destroyed |
| TTFB=0 upstream 5xx | Refund triggered |
| TTFB>0 then fail | No refund |
| **v1.7.7: Streaming idempotency replay** | Returns 409 Conflict, NOT free upstream call |

### Circuit Breaker Tests

| Test | Expected Outcome |
|------|------------------|
| OPEN→HALF_OPEN transition | success_count, fail_count, window_start all reset |
| HALF_OPEN success threshold | Clean transition to CLOSED |

### BigInt Safety Tests

| Test | Expected Outcome |
|------|------------------|
| Wallet balance near 2^53 | No precision loss |
| INCRBY return with large values | String conversion preserves accuracy |
| **v1.7.7: Prisma increment/decrement** | BigInt() wrapper used, no type errors |

---

## v1.7.6 Summary: Owner-Scoped Idempotency & Single Mutation Point

### Key Changes in v1.7.6

| Issue | Fix | Impact |
|-------|-----|--------|
| **Cross-tenant idempotency collision** | All `idem:*` keys now include `{ownerType}:{ownerId}` | 🔒 Security: Prevents data leak between tenants |
| **Double Redis mutation** | `WalletService.chargeWallet()` no longer mutates Redis | ⚡ Consistency: billing.lua is single mutation point |
| **Top-up race condition** | `addBalance()` uses `INCRBY` instead of `SET` | ⚡ Consistency: No lost updates from concurrent operations |
| **Header cache security** | Response cache uses header whitelist | 🔒 Security: No `set-cookie` or problematic header replay |
| **BigInt max confusion** | Clarified max 2^53-1 enforced at ALL write paths | 📖 Clarity: `tonumber()` comparison is safe with enforced limit |

### Affected Redis Keys

Old format → New format:
```
idem:billing:{requestId}                    → idem:billing:{ownerType}:{ownerId}:{requestId}
idem:refund:{requestId}                     → idem:refund:{ownerType}:{ownerId}:{requestId}
idem:response:{requestId}                   → idem:response:{ownerType}:{ownerId}:{requestId}
```

### Affected Code Paths

1. **BillingGuard**: Update Lua key construction
2. **WalletService.chargeWallet()**: Remove Redis INCRBY, accept `newBalanceFromLua` param
3. **WalletService.addBalance()**: Change `redis.set()` to `redis.incrby()`
4. **cacheIdempotentResponse()**: Add header whitelist filter
5. **handleIdempotentRequest()**: Update cache key format

### Migration Notes

If upgrading from v1.7.5 to v1.7.6:
- Old idempotency keys will naturally expire (24h TTL)
- No data migration needed
- Concurrent requests during upgrade may see brief inconsistency (acceptable)

---

## v1.7.7 Summary: Ship Blockers Resolved

### Key Changes in v1.7.7

| Issue | Fix | Impact |
|-------|-----|--------|
| **Response cache not owner-scoped** | `handleIdempotentRequest()` now uses `idem:response:${ownerType}:${ownerId}:${requestId}` | 🔒 Security: Cross-tenant response leak prevented |
| **Prisma BigInt type mismatch** | All `increment/decrement` operations now use `BigInt(amountCents)` | ⚡ Consistency: No TypeScript/runtime type errors |
| **Dispute ledger wrong balance** | `handleDisputeCreated()` now writes `wallet.balanceCents` instead of `0n` | 📖 Audit: Accurate balance trail |
| **Redis cold start 402 bug** | New `bootstrapWalletIfMissing()` function loads DB balance to Redis | ⚡ Reliability: No false 402 after Redis flush |
| **Refund path order** | Clarified: DB transaction FIRST, then Redis INCRBY | ⚡ Durability: DB is source of truth |
| **Comprehensive test scenarios** | Added 15+ new test cases for security & race conditions | 🧪 Quality: Ship with confidence |

### Affected Code Paths

1. **handleIdempotentRequest()**: Added `ownerType` and `ownerId` parameters, updated cache key
2. **handleDisputeCreated()**: Capture wallet before update, use actual balance in ledger
3. **handleDisputeLost()**: Added `BigInt()` wrapper for Prisma decrement
4. **WalletService.chargeWallet()**: Added `BigInt()` wrapper for Prisma decrement
5. **WalletService.refundWallet()**: Clarified DB-first order in comments
6. **reconcileWallet()**: Added `bootstrapWalletIfMissing()` companion function
7. **AuthGuard**: Should call `loadPolicyWithWalletBootstrap()` instead of just `loadPolicy()`

### Redis Cold Start Bootstrap Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     WALLET BOOTSTRAP FLOW (v1.7.7)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Request arrives                                                      │
│  2. AuthGuard validates API key + loads policy                          │
│  3. AuthGuard calls bootstrapWalletIfMissing(ownerType, ownerId)        │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │  Redis EXISTS wallet:{ownerType}:{ownerId}:balance_cents?   │     │
│     │     YES → return (already bootstrapped)                      │     │
│     │     NO  → Query DB for wallet balance                        │     │
│     │           → SETNX to Redis (atomic, no overwrite)            │     │
│     └─────────────────────────────────────────────────────────────┘     │
│  4. BillingGuard now sees correct balance in Redis                      │
│  5. Request proceeds normally                                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Refund Path Order (v1.7.7 Clarification)

**Previous ambiguity:** Was it Lua (Redis) first, then DB? Or DB first, then Redis?

**v1.7.7 Recommendation:** DB transaction FIRST, then Redis INCRBY

```typescript
// RECOMMENDED ORDER for refundWallet():
// 1. Check idempotency + daily cap in Redis (Lua script - READ operations)
// 2. DB transaction: Update wallet_balance + write wallet_ledger
// 3. Redis INCRBY: Credit the refund amount
//
// WHY THIS ORDER?
// - If DB fails: No Redis mutation happened, clean state
// - If Redis fails after DB: Reconciliation job fixes it (DB is source of truth)
// - If we did Redis first: DB fail means Redis has credit without ledger entry
```

### Migration Notes

If upgrading from v1.7.6 to v1.7.7:
- Old idempotency keys will naturally expire (24h TTL) - no migration needed
- Add `bootstrapWalletIfMissing()` call to AuthGuard
- Update Prisma increment/decrement calls with `BigInt()` wrapper
- Run tests from new test scenarios table

### v1.7.7 Ship Blockers Checklist

- [ ] `handleIdempotentRequest()` updated with owner params
- [ ] All Prisma `increment/decrement` use `BigInt()` wrapper
- [ ] `handleDisputeCreated()` uses actual wallet balance
- [ ] `bootstrapWalletIfMissing()` added and called in AuthGuard
- [ ] Refund path follows DB-first order
- [ ] Cross-tenant idempotency tests pass
- [ ] Cold start tests pass
- [ ] Double-mutate race tests pass

---

*This guide is the primary reference for implementing the Omniway.ai backend (v1.7.7 SHIP-READY). Each phase builds on the previous one, so complete them in order.*

### Migration Notes

If upgrading from v1.7.5 to v1.7.6:
- Old idempotency keys will naturally expire (24h TTL)
- No data migration needed
- Concurrent requests during upgrade may see brief inconsistency (acceptable)

---

*This guide is the primary reference for implementing the Omniway.ai backend (v1.7.6 FINAL). Each phase builds on the previous one, so complete them in order.*