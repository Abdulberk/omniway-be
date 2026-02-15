-- Omniway.ai Initial Migration
-- This migration creates all tables and constraints

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER', 'BILLING');
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING', 'PAUSED');
CREATE TYPE "WalletTxType" AS ENUM ('TOPUP', 'CHARGE', 'REFUND', 'ADMIN_ADJUSTMENT', 'CHARGEBACK', 'PROMO');
CREATE TYPE "ApiKeyOwnerType" AS ENUM ('USER', 'PROJECT');
CREATE TYPE "RequestStatus" AS ENUM ('SUCCESS', 'CLIENT_ERROR', 'UPSTREAM_ERROR', 'TIMEOUT', 'RATE_LIMITED', 'BILLING_BLOCKED');
CREATE TYPE "AuditAction" AS ENUM ('USER_LOGIN', 'USER_LOGOUT', 'USER_CREATED', 'USER_UPDATED', 'USER_DELETED', 'ORG_CREATED', 'ORG_UPDATED', 'ORG_DELETED', 'MEMBER_INVITED', 'MEMBER_JOINED', 'MEMBER_REMOVED', 'MEMBER_ROLE_CHANGED', 'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_DELETED', 'API_KEY_CREATED', 'API_KEY_ROTATED', 'API_KEY_REVOKED', 'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_UPDATED', 'SUBSCRIPTION_CANCELED', 'WALLET_TOPUP', 'WALLET_ADJUSTMENT', 'PLAN_CHANGED', 'SETTINGS_CHANGED');
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- ============================================================================
-- TABLES
-- ============================================================================

-- Users
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" TIMESTAMP(3),
    "password_hash" TEXT,
    "name" TEXT,
    "avatar_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "stripe_customer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Organizations
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT,
    "max_seats" INTEGER NOT NULL DEFAULT 5,
    "ip_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- Memberships
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'DEVELOPER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- Projects
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- Plans
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "stripe_price_id" TEXT,
    "stripe_product_id" TEXT,
    "price_monthly" INTEGER NOT NULL DEFAULT 0,
    "price_yearly" INTEGER NOT NULL DEFAULT 0,
    "limit_per_minute" INTEGER NOT NULL DEFAULT 20,
    "limit_per_hour" INTEGER NOT NULL DEFAULT 100,
    "limit_per_day" INTEGER NOT NULL DEFAULT 500,
    "daily_allowance" INTEGER NOT NULL DEFAULT 500,
    "max_concurrent" INTEGER NOT NULL DEFAULT 5,
    "max_input_tokens" INTEGER NOT NULL DEFAULT 8000,
    "max_output_tokens" INTEGER NOT NULL DEFAULT 4000,
    "max_body_bytes" INTEGER NOT NULL DEFAULT 1048576,
    "max_seats" INTEGER NOT NULL DEFAULT 1,
    "price_per_seat" INTEGER NOT NULL DEFAULT 0,
    "allowed_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "is_free" BOOLEAN NOT NULL DEFAULT false,
    "has_wallet_access" BOOLEAN NOT NULL DEFAULT true,
    "has_streaming" BOOLEAN NOT NULL DEFAULT true,
    "has_priority_queue" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- Subscriptions
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "stripe_subscription_id" TEXT,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMP(3),
    "seat_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- Wallet Balances
CREATE TABLE "wallet_balances" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "total_topup_cents" BIGINT NOT NULL DEFAULT 0,
    "total_spent_cents" BIGINT NOT NULL DEFAULT 0,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "locked_reason" TEXT,
    "locked_at" TIMESTAMP(3),
    "last_reconciled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_balances_pkey" PRIMARY KEY ("id")
);

-- Wallet Ledger
CREATE TABLE "wallet_ledger" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "tx_type" "WalletTxType" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "request_id" TEXT,
    "stripe_payment_id" TEXT,
    "description" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- Topup Packages
CREATE TABLE "topup_packages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "credit_cents" INTEGER NOT NULL,
    "stripe_price_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_popular" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topup_packages_pkey" PRIMARY KEY ("id")
);

-- API Keys
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_type" "ApiKeyOwnerType" NOT NULL,
    "user_id" TEXT,
    "project_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY['chat:write', 'embeddings:write']::TEXT[],
    "allowed_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "usage_count" BIGINT NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- Model Catalog
CREATE TABLE "model_catalog" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "upstream_model_id" TEXT NOT NULL,
    "supports_streaming" BOOLEAN NOT NULL DEFAULT true,
    "supports_vision" BOOLEAN NOT NULL DEFAULT false,
    "supports_tool_calls" BOOLEAN NOT NULL DEFAULT false,
    "supports_function_call" BOOLEAN NOT NULL DEFAULT false,
    "supports_json" BOOLEAN NOT NULL DEFAULT false,
    "max_context_tokens" INTEGER NOT NULL DEFAULT 8192,
    "max_output_tokens" INTEGER NOT NULL DEFAULT 4096,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deprecated" BOOLEAN NOT NULL DEFAULT false,
    "deprecation_date" TIMESTAMP(3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_catalog_pkey" PRIMARY KEY ("id")
);

-- Model Request Pricing
CREATE TABLE "model_request_pricing" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "input_price_per_1m" INTEGER NOT NULL,
    "output_price_per_1m" INTEGER NOT NULL,
    "original_input_price" INTEGER NOT NULL,
    "original_output_price" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_request_pricing_pkey" PRIMARY KEY ("id")
);

-- Request Events
CREATE TABLE "request_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "owner_type" "ApiKeyOwnerType" NOT NULL,
    "owner_id" TEXT NOT NULL,
    "project_id" TEXT,
    "api_key_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL,
    "status_code" INTEGER NOT NULL,
    "error_type" TEXT,
    "error_message" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "ttfb_ms" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "input_bytes" INTEGER NOT NULL,
    "output_bytes" INTEGER NOT NULL,
    "billing_source" TEXT,
    "cost_cents" INTEGER,
    "pricing_snapshot_id" TEXT,
    "is_streaming" BOOLEAN NOT NULL DEFAULT false,
    "stream_chunks" INTEGER,
    "client_ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_events_pkey" PRIMARY KEY ("id")
);

-- Pricing Snapshots
CREATE TABLE "pricing_snapshots" (
    "id" TEXT NOT NULL,
    "snapshot_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_snapshots_pkey" PRIMARY KEY ("id")
);

-- Usage Daily
CREATE TABLE "usage_daily" (
    "id" TEXT NOT NULL,
    "owner_type" "ApiKeyOwnerType" NOT NULL,
    "owner_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "total_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_output_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_cost_cents" BIGINT NOT NULL DEFAULT 0,
    "allowance_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("id")
);

-- Stripe Events
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "stripe_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- Audit Logs
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_type" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- Notification Preferences
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email_usage_alerts" BOOLEAN NOT NULL DEFAULT true,
    "email_billing_alerts" BOOLEAN NOT NULL DEFAULT true,
    "email_security_alerts" BOOLEAN NOT NULL DEFAULT true,
    "email_product_updates" BOOLEAN NOT NULL DEFAULT false,
    "usage_alert_threshold" INTEGER NOT NULL DEFAULT 80,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- Organization Invitations
CREATE TABLE "organization_invitations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'DEVELOPER',
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- Upstream API Keys
CREATE TABLE "upstream_api_keys" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encrypted_key" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "last_health_check" TIMESTAMP(3),
    "health_status" TEXT,
    "rate_limit" INTEGER,
    "rate_limit_window" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_api_keys_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- UNIQUE INDEXES
-- ============================================================================

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
CREATE UNIQUE INDEX "organizations_stripe_customer_id_key" ON "organizations"("stripe_customer_id");
CREATE UNIQUE INDEX "memberships_user_id_organization_id_key" ON "memberships"("user_id", "organization_id");
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");
CREATE UNIQUE INDEX "plans_slug_key" ON "plans"("slug");
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions"("user_id");
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");
CREATE UNIQUE INDEX "wallet_balances_user_id_key" ON "wallet_balances"("user_id");
CREATE UNIQUE INDEX "wallet_balances_organization_id_key" ON "wallet_balances"("organization_id");
CREATE UNIQUE INDEX "wallet_ledger_idempotency_key_key" ON "wallet_ledger"("idempotency_key");
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE UNIQUE INDEX "model_catalog_model_id_key" ON "model_catalog"("model_id");
CREATE UNIQUE INDEX "request_events_request_id_key" ON "request_events"("request_id");
CREATE UNIQUE INDEX "usage_daily_owner_type_owner_id_date_key" ON "usage_daily"("owner_type", "owner_id", "date");
CREATE UNIQUE INDEX "stripe_events_stripe_event_id_key" ON "stripe_events"("stripe_event_id");
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");
CREATE UNIQUE INDEX "organization_invitations_token_key" ON "organization_invitations"("token");

-- ============================================================================
-- PARTIAL UNIQUE INDEXES (for XOR constraints simulation)
-- ============================================================================

-- Upstream API Keys: only one primary per provider
CREATE UNIQUE INDEX "upstream_api_keys_provider_is_primary_key" 
ON "upstream_api_keys"("provider", "is_primary") 
WHERE "is_primary" = true;

-- ============================================================================
-- REGULAR INDEXES
-- ============================================================================

CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");
CREATE INDEX "wallet_ledger_user_id_created_at_idx" ON "wallet_ledger"("user_id", "created_at");
CREATE INDEX "wallet_ledger_organization_id_created_at_idx" ON "wallet_ledger"("organization_id", "created_at");
CREATE INDEX "model_request_pricing_model_id_effective_from_idx" ON "model_request_pricing"("model_id", "effective_from");
CREATE INDEX "request_events_owner_id_created_at_idx" ON "request_events"("owner_id", "created_at");
CREATE INDEX "request_events_api_key_id_created_at_idx" ON "request_events"("api_key_id", "created_at");
CREATE INDEX "request_events_model_created_at_idx" ON "request_events"("model", "created_at");
CREATE INDEX "request_events_created_at_idx" ON "request_events"("created_at");
CREATE INDEX "usage_daily_owner_id_date_idx" ON "usage_daily"("owner_id", "date");
CREATE INDEX "stripe_events_event_type_processed_idx" ON "stripe_events"("event_type", "processed");
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");
CREATE INDEX "organization_invitations_email_status_idx" ON "organization_invitations"("email", "status");
CREATE INDEX "organization_invitations_organization_id_status_idx" ON "organization_invitations"("organization_id", "status");

-- ============================================================================
-- CHECK CONSTRAINTS (XOR for owner fields)
-- ============================================================================

-- Subscriptions: must have exactly one of user_id OR organization_id
ALTER TABLE "subscriptions" 
ADD CONSTRAINT "subscriptions_owner_xor_check" 
CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR 
    (user_id IS NULL AND organization_id IS NOT NULL)
);

-- Wallet Balances: must have exactly one of user_id OR organization_id
ALTER TABLE "wallet_balances" 
ADD CONSTRAINT "wallet_balances_owner_xor_check" 
CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR 
    (user_id IS NULL AND organization_id IS NOT NULL)
);

-- Wallet Ledger: must have exactly one of user_id OR organization_id
ALTER TABLE "wallet_ledger" 
ADD CONSTRAINT "wallet_ledger_owner_xor_check" 
CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) OR 
    (user_id IS NULL AND organization_id IS NOT NULL)
);

-- API Keys: must have exactly one of user_id OR project_id based on owner_type
ALTER TABLE "api_keys" 
ADD CONSTRAINT "api_keys_owner_xor_check" 
CHECK (
    (owner_type = 'USER' AND user_id IS NOT NULL AND project_id IS NULL) OR 
    (owner_type = 'PROJECT' AND user_id IS NULL AND project_id IS NOT NULL)
);

-- ============================================================================
-- FOREIGN KEY CONSTRAINTS
-- ============================================================================

ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" 
FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" 
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" 
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" 
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" 
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" 
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" 
FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_user_id_fkey" 
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_organization_id_fkey" 
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_fkey" 
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_organization_id_fkey" 
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" 
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" 
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "model_request_pricing" ADD CONSTRAINT "model_request_pricing_model_id_fkey" 
FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" 
FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" 
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" 
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_id_fkey" 
FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- SEED DATA: Default Free Plan
-- ============================================================================

INSERT INTO "plans" (
    "id", 
    "name", 
    "slug", 
    "description",
    "limit_per_minute",
    "limit_per_hour",
    "limit_per_day",
    "daily_allowance",
    "max_concurrent",
    "is_free",
    "created_at",
    "updated_at"
) VALUES (
    'plan_free_default',
    'Free',
    'free',
    'Free plan with limited daily requests',
    10,
    50,
    100,
    100,
    2,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);