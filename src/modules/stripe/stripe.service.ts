import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import {
    CreateSubscriptionCheckoutParams,
    CreateTopupCheckoutParams,
    CreateBillingPortalParams,
    CreateCustomerParams,
    CheckoutMetadata,
    OwnerInfo,
} from './interfaces/stripe.interfaces';

@Injectable()
export class StripeService implements OnModuleInit {
    private readonly logger = new Logger(StripeService.name);
    private stripe: Stripe;

    constructor(
        private readonly configService: ConfigService,
        private readonly prisma: PrismaService,
    ) { }

    onModuleInit() {
        const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
        if (!secretKey) {
            throw new Error('STRIPE_SECRET_KEY is required');
        }

        this.stripe = new Stripe(secretKey, {
            typescript: true,
        });

        this.logger.log('Stripe SDK initialized');
    }

    /**
     * Create a new Stripe customer
     */
    async createCustomer(params: CreateCustomerParams): Promise<string> {
        const { email, name, userId, organizationId } = params;

        const customer = await this.stripe.customers.create({
            email,
            name,
            metadata: {
                user_id: userId || '',
                organization_id: organizationId || '',
            },
        });

        this.logger.log(`Created Stripe customer ${customer.id}`);
        return customer.id;
    }

    /**
     * Get or create a Stripe customer for a user
     */
    async getOrCreateCustomerForUser(userId: string): Promise<string> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeCustomerId: true, email: true, name: true },
        });

        if (!user) {
            throw new BadRequestException('User not found');
        }

        if (user.stripeCustomerId) {
            return user.stripeCustomerId;
        }

        const customerId = await this.createCustomer({
            email: user.email,
            name: user.name || undefined,
            userId,
        });

        await this.prisma.user.update({
            where: { id: userId },
            data: { stripeCustomerId: customerId },
        });

        return customerId;
    }

    /**
     * Get or create a Stripe customer for an organization
     */
    async getOrCreateCustomerForOrg(organizationId: string): Promise<string> {
        const org = await this.prisma.organization.findUnique({
            where: { id: organizationId },
            select: { stripeCustomerId: true, name: true, owner: { select: { email: true } } },
        });

        if (!org) {
            throw new BadRequestException('Organization not found');
        }

        if (org.stripeCustomerId) {
            return org.stripeCustomerId;
        }

        const customerId = await this.createCustomer({
            email: org.owner.email,
            name: org.name,
            organizationId,
        });

        await this.prisma.organization.update({
            where: { id: organizationId },
            data: { stripeCustomerId: customerId },
        });

        return customerId;
    }

    /**
     * Create a checkout session for subscription
     */
    async createSubscriptionCheckout(
        params: CreateSubscriptionCheckoutParams,
    ): Promise<{ checkoutUrl: string; sessionId: string }> {
        const { userId, organizationId, planId, successUrl, cancelUrl, seatCount } = params;

        // Get the plan with Stripe price ID
        const plan = await this.prisma.plan.findUnique({
            where: { id: planId },
            select: { stripePriceId: true, name: true },
        });

        if (!plan || !plan.stripePriceId) {
            throw new BadRequestException('Plan not found or does not have Stripe price');
        }

        // Get or create customer
        let customerId: string;
        if (organizationId) {
            customerId = await this.getOrCreateCustomerForOrg(organizationId);
        } else if (userId) {
            customerId = await this.getOrCreateCustomerForUser(userId);
        } else {
            throw new BadRequestException('Either userId or organizationId is required');
        }

        const metadata: CheckoutMetadata = {
            type: 'subscription',
            user_id: userId,
            organization_id: organizationId,
            plan_id: planId,
        };

        const session = await this.stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'subscription',
            line_items: [
                {
                    price: plan.stripePriceId,
                    quantity: seatCount || 1,
                },
            ],
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: metadata as unknown as Stripe.MetadataParam,
            subscription_data: {
                metadata: metadata as unknown as Stripe.MetadataParam,
            },
        });

        this.logger.log(`Created subscription checkout session ${session.id} for plan ${planId}`);

        return {
            checkoutUrl: session.url!,
            sessionId: session.id,
        };
    }

    /**
     * Create a checkout session for top-up (one-time payment)
     */
    async createTopupCheckout(
        params: CreateTopupCheckoutParams,
    ): Promise<{ checkoutUrl: string; sessionId: string }> {
        const { userId, organizationId, packageId, amountCents, creditCents, successUrl, cancelUrl } = params;

        let priceId: string | undefined;
        let lineItemAmount: number | undefined;
        let actualCreditCents: number;

        // If packageId provided, use pre-defined package
        if (packageId) {
            const topupPackage = await this.prisma.topupPackage.findUnique({
                where: { id: packageId },
                select: { stripePriceId: true, amountCents: true, creditCents: true, isActive: true },
            });

            if (!topupPackage || !topupPackage.isActive) {
                throw new BadRequestException('Top-up package not found or inactive');
            }

            priceId = topupPackage.stripePriceId || undefined;
            lineItemAmount = topupPackage.amountCents;
            actualCreditCents = topupPackage.creditCents;
        } else if (amountCents && creditCents) {
            // Custom amount top-up
            lineItemAmount = amountCents;
            actualCreditCents = creditCents;
        } else {
            throw new BadRequestException('Either packageId or amountCents/creditCents is required');
        }

        // Get or create customer
        let customerId: string;
        if (organizationId) {
            customerId = await this.getOrCreateCustomerForOrg(organizationId);
        } else if (userId) {
            customerId = await this.getOrCreateCustomerForUser(userId);
        } else {
            throw new BadRequestException('Either userId or organizationId is required');
        }

        const metadata: CheckoutMetadata = {
            type: 'topup',
            user_id: userId,
            organization_id: organizationId,
            amount_cents: lineItemAmount?.toString(),
            credit_cents: actualCreditCents.toString(),
            currency: 'usd',
        };

        let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];

        if (priceId) {
            // Use pre-defined Stripe price
            lineItems = [{ price: priceId, quantity: 1 }];
        } else {
            // Create price on the fly for custom amount
            lineItems = [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `Wallet Top-up ($${(lineItemAmount! / 100).toFixed(2)})`,
                        },
                        unit_amount: lineItemAmount,
                    },
                    quantity: 1,
                },
            ];
        }

        const session = await this.stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'payment',
            line_items: lineItems,
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: metadata as unknown as Stripe.MetadataParam,
            payment_intent_data: {
                metadata: metadata as unknown as Stripe.MetadataParam,
            },
        });

        this.logger.log(`Created topup checkout session ${session.id}`);

        return {
            checkoutUrl: session.url!,
            sessionId: session.id,
        };
    }

    /**
     * Create a billing portal session for managing subscription
     */
    async createBillingPortal(
        params: CreateBillingPortalParams,
    ): Promise<{ portalUrl: string }> {
        const { stripeCustomerId, returnUrl } = params;

        const session = await this.stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: returnUrl,
        });

        this.logger.log(`Created billing portal session for customer ${stripeCustomerId}`);

        return {
            portalUrl: session.url,
        };
    }

    /**
     * Verify webhook signature and construct event
     */
    constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
        const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
        if (!webhookSecret) {
            throw new Error('STRIPE_WEBHOOK_SECRET is required');
        }

        return this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    }

    /**
     * Extract owner info from checkout metadata or customer
     */
    async extractOwnerFromMetadata(metadata: Stripe.Metadata | null): Promise<OwnerInfo | null> {
        if (!metadata) return null;

        if (metadata.organization_id) {
            return { ownerType: 'org', ownerId: metadata.organization_id };
        }

        if (metadata.user_id) {
            return { ownerType: 'user', ownerId: metadata.user_id };
        }

        return null;
    }

    /**
     * Find owner from Stripe customer ID
     */
    async findOwnerByCustomerId(stripeCustomerId: string): Promise<OwnerInfo | null> {
        // Check organizations first
        const org = await this.prisma.organization.findFirst({
            where: { stripeCustomerId },
            select: { id: true },
        });

        if (org) {
            return { ownerType: 'org', ownerId: org.id };
        }

        // Check users
        const user = await this.prisma.user.findFirst({
            where: { stripeCustomerId },
            select: { id: true },
        });

        if (user) {
            return { ownerType: 'user', ownerId: user.id };
        }

        return null;
    }

    /**
     * Retrieve subscription details
     */
    async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
        return this.stripe.subscriptions.retrieve(subscriptionId, {
            expand: ['items.data.price.product'],
        });
    }

    /**
     * Cancel subscription at period end
     */
    async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<Stripe.Subscription> {
        const subscription = await this.stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
        });

        this.logger.log(`Subscription ${subscriptionId} set to cancel at period end`);
        return subscription;
    }

    /**
     * Resume a subscription that was set to cancel
     */
    async resumeSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
        const subscription = await this.stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: false,
        });

        this.logger.log(`Subscription ${subscriptionId} resumed`);
        return subscription;
    }

    /**
     * Get checkout session details
     */
    async getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
        return this.stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['subscription', 'payment_intent'],
        });
    }

    /**
     * Get invoice details
     */
    async getInvoice(invoiceId: string): Promise<Stripe.Invoice> {
        return this.stripe.invoices.retrieve(invoiceId, {
            expand: ['subscription', 'payment_intent'],
        });
    }

    /**
     * Get charge details
     */
    async getCharge(chargeId: string): Promise<Stripe.Charge> {
        return this.stripe.charges.retrieve(chargeId);
    }

    /**
     * Get dispute details
     */
    async getDispute(disputeId: string): Promise<Stripe.Dispute> {
        return this.stripe.disputes.retrieve(disputeId);
    }

    /**
     * Get raw Stripe instance (for advanced operations)
     */
    getStripeInstance(): Stripe {
        return this.stripe;
    }
}