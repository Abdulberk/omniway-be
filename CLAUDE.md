# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Omniway.ai Backend — an OpenAI-compatible API Gateway built with NestJS + Fastify. It provides multi-tenant support (orgs → projects → API keys), Stripe billing with daily allowance + wallet model, Redis-based rate limiting, and async usage tracking via BullMQ.

## Commands

```bash
# Development
npm run start:dev          # Hot-reload dev server (port 3000)
npm run start:debug        # Debug mode with --watch

# Build
npm run build              # Compile TypeScript via NestJS CLI → dist/
npm run start:prod         # Run compiled output

# Infrastructure (PostgreSQL 16 + Redis 7)
docker-compose up -d       # Start Postgres and Redis containers

# Database
npx prisma generate        # Regenerate Prisma client after schema changes
npx prisma migrate dev --name <name>  # Create new migration
npx prisma migrate deploy  # Apply migrations (production)
npx prisma studio          # Visual database browser
npm run db:seed            # Seed database (ts-node prisma/seed.ts)

# Testing
npm run test               # Run unit tests (Jest)
npm run test:watch         # Watch mode
npm run test:cov           # Coverage report
npm run test:e2e           # E2E tests (separate jest config: test/jest-e2e.json)
npx jest --testPathPattern=<pattern>  # Run a single test file

# Code quality
npm run lint               # ESLint with auto-fix
npm run format             # Prettier formatting
```

## Architecture

### Request Pipeline (Guard Chain)

Every gateway request passes through guards in this exact order:

```
Client → Fastify → RequestIdInterceptor → LoggingInterceptor
  → AuthGuard → RateLimitGuard → ConcurrencyGuard
  → ModelAccessGuard → BillingGuard → CircuitBreaker
  → ProxyService (upstream call) → Response/Stream
  → Async: UsageService → BullMQ → UsageEventsProcessor → Postgres
```

### Module Organization

All feature modules live under `src/modules/`. Core infrastructure lives at the top level of `src/`:

- **`prisma/`** and **`redis/`** — Global modules (injected everywhere). PrismaService wraps the database client; RedisService wraps ioredis.
- **`common/`** — Global exception filter (`AllExceptionsFilter`), interceptors (`RequestIdInterceptor`, `LoggingInterceptor`), custom decorators.
- **`config/`** — Joi-based env validation schema (`config.validation.ts`). All required/optional env vars are defined here.

Feature modules:

- **`gateway/`** — Core proxy logic. `GatewayController` handles `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`. `ProxyService` (largest file, ~528 lines) manages upstream proxying for both streaming and non-streaming. `CircuitBreakerService` tracks per-provider failure rates.
- **`auth/`** — `ApiKeyService` validates keys (format, expiry, IP allowlist). `PolicyService` enforces RBAC. `AuthGuard` extracts the Authorization header and builds an `AuthContext`.
- **`billing/`** — Daily allowance + wallet system. `BillingGuard` pre-charges before proxying. `RefundService` handles automatic refunds for upstream failures with TTFB=0. Contains two Lua scripts for atomic Redis operations.
- **`rate-limit/`** — Three-tier (per-minute/hour/day) + concurrency limiting. `RateLimitGuard` and `ConcurrencyGuard` use Lua scripts for atomic Redis operations.
- **`usage/`** — `UsageService` emits `RequestCompletedEvent` to BullMQ. `UsageEventsProcessor` persists to `RequestEvent` table and updates `UsageDaily` aggregates.
- **`stripe/`** — Webhook handling with raw body signature verification. `StripeWebhookProcessor` processes events asynchronously with retry.
- **`admin/`** and **`account/`** — CRUD operations with their own guards (`AdminGuard`, `UserGuard`).

### Redis Lua Scripts

Four Lua scripts in `src/modules/*/lua/` provide atomic operations:

| Script | Purpose |
|--------|---------|
| `rate-limit/lua/rate-limit.lua` | Atomic 3-tier rate check + increment |
| `rate-limit/lua/concurrency.lua` | Slot-based concurrency with auto-release |
| `billing/lua/billing.lua` | Allowance-or-wallet decision with idempotency |
| `billing/lua/refund.lua` | Atomic refund with daily cap (10/day) |

### Billing Model

1. **Daily Allowance** — Plan grants N free requests/day, resets at UTC midnight. Tracked in Redis with auto-expiring keys.
2. **Wallet** — When allowance exhausted, charges from wallet balance (per-model pricing in cents). Uses `INCRBY` for BigInt-safe atomic deductions.
3. **Idempotency** — Owner-scoped idempotency keys prevent double-billing. Cached results replayed for duplicate requests.
4. **Refunds** — Only for upstream failures where TTFB=0 (no data sent). Max 10 refunds/day per owner.

### Database Schema

Prisma schema at `prisma/schema.prisma` (~795 lines). Key models: `User`, `Organization`, `Project`, `ApiKey`, `Subscription`, `Plan`, `Wallet`, `WalletLedger`, `ModelPrice`, `RequestEvent` (90-day TTL), `UsageDaily` (13-month TTL), `AuditLog`. Owner types are `USER` or `PROJECT` (`ApiKeyOwnerType` enum).

### TypeScript Path Aliases

Configured in `tsconfig.json`:
- `@/*` → `src/*`
- `@common/*` → `src/common/*`
- `@config/*` → `src/config/*`
- `@modules/*` → `src/modules/*`
- `@prisma/*` → `src/prisma/*`

### Global Prefix

API routes use `/v1` prefix. Excluded from prefix: `/health`, `/health/ready`, `/health/live`, `/webhooks/stripe`.

## Environment

Required env vars (validated by Joi in `src/config/config.validation.ts`): `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (min 32 chars), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `UPSTREAM_API_KEY`. See `.env.example` for all options.

Config loads from `.env.local` first, then `.env`.

## Code Style

- Prettier: single quotes, trailing commas, 2-space indent, 80-char width, LF line endings
- ESLint: `@typescript-eslint/no-explicit-any` is warn (not error). Unused vars must be prefixed with `_`. `console.log` is warned; only `console.warn`/`console.error` allowed.
- Use Pino logger (via NestJS `Logger`) instead of `console.*` for application logging.
