import Stripe from 'stripe';

/**
 * Stripe webhook event types we handle
 */
export const STRIPE_EVENTS = {
    CHECKOUT_SESSION_COMPLETED: 'checkout.session.completed',
    INVOICE_PAID: 'invoice.paid',
    INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
    CUSTOMER_SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
    CUSTOMER_SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
    CHARGE_DISPUTE_CREATED: 'charge.dispute.created',
    CHARGE_DISPUTE_CLOSED: 'charge.dispute.closed',
    CHARGE_REFUNDED: 'charge.refunded',
} as const;

export type StripeEventType = typeof STRIPE_EVENTS[keyof typeof STRIPE_EVENTS];

/**
 * Checkout session metadata types
 */
export type CheckoutMetadataType = 'subscription' | 'topup';

/**
 * Checkout session metadata
 */
export interface CheckoutMetadata {
    type: CheckoutMetadataType;
    user_id?: string;
    organization_id?: string;
    plan_id?: string;
    amount_cents?: string;
    credit_cents?: string;
    currency?: string;
}

/**
 * Create subscription checkout params
 */
export interface CreateSubscriptionCheckoutParams {
    userId?: string;
    organizationId?: string;
    planId: string;
    successUrl: string;
    cancelUrl: string;
    seatCount?: number;
}

/**
 * Create top-up checkout params
 */
export interface CreateTopupCheckoutParams {
    userId?: string;
    organizationId?: string;
    packageId?: string;
    amountCents?: number;
    creditCents?: number;
    successUrl: string;
    cancelUrl: string;
}

/**
 * Subscription update params
 */
export interface SubscriptionUpdateParams {
    stripeSubscriptionId: string;
    planId?: string;
    seatCount?: number;
    cancelAtPeriodEnd?: boolean;
}

/**
 * Webhook event job data
 */
export interface StripeWebhookJobData {
    stripeEventId: string;
    eventType: string;
    payload: Stripe.Event;
}

/**
 * Queue names for Stripe processing
 */
export const STRIPE_QUEUES = {
    WEBHOOKS: 'stripe:webhooks',
} as const;

/**
 * Job names
 */
export const STRIPE_JOBS = {
    PROCESS_WEBHOOK: 'process-webhook',
} as const;

/**
 * Owner info extracted from Stripe metadata or customer
 */
export interface OwnerInfo {
    ownerType: 'user' | 'org';
    ownerId: string;
}

/**
 * Billing portal params
 */
export interface CreateBillingPortalParams {
    stripeCustomerId: string;
    returnUrl: string;
}

/**
 * Stripe customer create params
 */
export interface CreateCustomerParams {
    email: string;
    name?: string;
    userId?: string;
    organizationId?: string;
}