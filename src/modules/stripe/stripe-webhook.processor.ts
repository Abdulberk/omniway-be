import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from './stripe.service';
import { WalletService } from '../billing/wallet.service';
import {
    STRIPE_QUEUES,
    STRIPE_EVENTS,
    StripeWebhookJobData,
    CheckoutMetadata,
} from './interfaces/stripe.interfaces';
import { SubscriptionStatus, WalletTxType } from '@prisma/client';

@Processor(STRIPE_QUEUES.WEBHOOKS)
export class StripeWebhookProcessor extends WorkerHost {
    private readonly logger = new Logger(StripeWebhookProcessor.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly stripeService: StripeService,
        private readonly walletService: WalletService,
    ) {
        super();
    }

    async process(job: Job<StripeWebhookJobData>): Promise<void> {
        const { stripeEventId, eventType, payload } = job.data;

        this.logger.log(`Processing Stripe event: ${eventType} (${stripeEventId})`);

        try {
            // Route to appropriate handler
            switch (eventType) {
                case STRIPE_EVENTS.CHECKOUT_SESSION_COMPLETED:
                    await this.handleCheckoutCompleted(payload);
                    break;

                case STRIPE_EVENTS.INVOICE_PAID:
                    await this.handleInvoicePaid(payload);
                    break;

                case STRIPE_EVENTS.INVOICE_PAYMENT_FAILED:
                    await this.handlePaymentFailed(payload);
                    break;

                case STRIPE_EVENTS.CUSTOMER_SUBSCRIPTION_UPDATED:
                    await this.handleSubscriptionUpdated(payload);
                    break;

                case STRIPE_EVENTS.CUSTOMER_SUBSCRIPTION_DELETED:
                    await this.handleSubscriptionDeleted(payload);
                    break;

                case STRIPE_EVENTS.CHARGE_DISPUTE_CREATED:
                    await this.handleDisputeCreated(payload);
                    break;

                case STRIPE_EVENTS.CHARGE_DISPUTE_CLOSED:
                    await this.handleDisputeClosed(payload);
                    break;

                case STRIPE_EVENTS.CHARGE_REFUNDED:
                    await this.handleRefund(payload);
                    break;

                default:
                    this.logger.log(`Unhandled event type: ${eventType}`);
            }

            // Mark event as processed
            await this.prisma.stripeEvent.update({
                where: { stripeEventId },
                data: {
                    processed: true,
                    processedAt: new Date(),
                },
            });

            this.logger.log(`Successfully processed Stripe event: ${stripeEventId}`);
        } catch (error) {
            this.logger.error(
                `Failed to process Stripe event ${stripeEventId}:`,
                error,
            );

            // Update retry count and error
            await this.prisma.stripeEvent.update({
                where: { stripeEventId },
                data: {
                    retryCount: { increment: 1 },
                    error: error.message,
                },
            });

            throw error; // Re-throw to trigger BullMQ retry
        }
    }

    /**
     * Handle checkout.session.completed
     * This fires when either a subscription or one-time payment checkout completes
     */
    private async handleCheckoutCompleted(event: Stripe.Event): Promise<void> {
        const session = event.data.object as Stripe.Checkout.Session;
        const metadata = session.metadata as unknown as CheckoutMetadata | null;

        if (!metadata) {
            this.logger.warn(`Checkout session ${session.id} has no metadata`);
            return;
        }

        const checkoutType = metadata.type;

        if (checkoutType === 'subscription') {
            await this.handleSubscriptionCheckoutCompleted(session, metadata);
        } else if (checkoutType === 'topup') {
            await this.handleTopupCheckoutCompleted(session, metadata);
        } else {
            this.logger.warn(`Unknown checkout type: ${checkoutType}`);
        }
    }

    /**
     * Handle subscription checkout completion
     */
    private async handleSubscriptionCheckoutCompleted(
        session: Stripe.Checkout.Session,
        metadata: CheckoutMetadata,
    ): Promise<void> {
        const stripeSubscriptionId = session.subscription as string;
        const planId = metadata.plan_id;

        if (!stripeSubscriptionId || !planId) {
            this.logger.error(
                `Missing subscription ID or plan ID in checkout ${session.id}`,
            );
            return;
        }

        // Get subscription details from Stripe
        const stripeSubscription =
            await this.stripeService.getSubscription(stripeSubscriptionId);

        // Determine owner
        const owner = await this.getOwnerFromMetadata(
            metadata,
            session.customer as string,
        );
        if (!owner) {
            this.logger.error(`Could not determine owner for checkout ${session.id}`);
            return;
        }

        // Extract period timestamps (handle both old and new Stripe SDK versions)
        const periodStart = (stripeSubscription as any).current_period_start;
        const periodEnd = (stripeSubscription as any).current_period_end;
        const quantity = stripeSubscription.items.data[0]?.quantity || 1;

        // Create or update subscription in our database
        await this.prisma.subscription.upsert({
            where:
                owner.type === 'user'
                    ? { userId: owner.id }
                    : { organizationId: owner.id },
            create: {
                userId: owner.type === 'user' ? owner.id : null,
                organizationId: owner.type === 'org' ? owner.id : null,
                planId,
                stripeSubscriptionId,
                status: SubscriptionStatus.ACTIVE,
                currentPeriodStart: new Date(periodStart * 1000),
                currentPeriodEnd: new Date(periodEnd * 1000),
                seatCount: quantity,
            },
            update: {
                planId,
                stripeSubscriptionId,
                status: SubscriptionStatus.ACTIVE,
                currentPeriodStart: new Date(periodStart * 1000),
                currentPeriodEnd: new Date(periodEnd * 1000),
                seatCount: quantity,
            },
        });

        this.logger.log(
            `Created/updated subscription for ${owner.type}:${owner.id}`,
        );
    }

    /**
     * Handle top-up checkout completion
     */
    private async handleTopupCheckoutCompleted(
        session: Stripe.Checkout.Session,
        metadata: CheckoutMetadata,
    ): Promise<void> {
        const creditCents = parseInt(metadata.credit_cents || '0', 10);

        if (!creditCents || creditCents <= 0) {
            this.logger.error(`Invalid credit_cents in checkout ${session.id}`);
            return;
        }

        // Determine owner
        const owner = await this.getOwnerFromMetadata(
            metadata,
            session.customer as string,
        );
        if (!owner) {
            this.logger.error(`Could not determine owner for checkout ${session.id}`);
            return;
        }

        // Add balance to wallet
        await this.walletService.addBalance({
            ownerType: owner.type,
            ownerId: owner.id,
            amountCents: creditCents,
            referenceType: 'stripe_session',
            referenceId: session.id,
            description: `Top-up: $${(parseInt(metadata.amount_cents || '0', 10) / 100).toFixed(2)} → $${(creditCents / 100).toFixed(2)} credit`,
        });

        this.logger.log(
            `Processed top-up for ${owner.type}:${owner.id}: $${(creditCents / 100).toFixed(2)}`,
        );
    }

    /**
     * Handle invoice.paid (subscription renewals)
     */
    private async handleInvoicePaid(event: Stripe.Event): Promise<void> {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription;

        if (!subscriptionId) {
            // This is a one-time payment, not a subscription renewal
            return;
        }

        const subscription = await this.prisma.subscription.findUnique({
            where: { stripeSubscriptionId: subscriptionId as string },
        });

        if (!subscription) {
            this.logger.warn(`Subscription not found for invoice ${invoice.id}`);
            return;
        }

        // Get updated subscription from Stripe
        const stripeSubscription = await this.stripeService.getSubscription(
            subscriptionId as string,
        );
        const periodStart = (stripeSubscription as any).current_period_start;
        const periodEnd = (stripeSubscription as any).current_period_end;

        // Update subscription period
        await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
                status: SubscriptionStatus.ACTIVE,
                currentPeriodStart: new Date(periodStart * 1000),
                currentPeriodEnd: new Date(periodEnd * 1000),
            },
        });

        this.logger.log(`Renewed subscription ${subscription.id}`);
    }

    /**
     * Handle invoice.payment_failed
     */
    private async handlePaymentFailed(event: Stripe.Event): Promise<void> {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription;

        if (!subscriptionId) {
            return;
        }

        const subscription = await this.prisma.subscription.findUnique({
            where: { stripeSubscriptionId: subscriptionId as string },
        });

        if (!subscription) {
            return;
        }

        // Update subscription status to PAST_DUE
        await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
                status: SubscriptionStatus.PAST_DUE,
            },
        });

        this.logger.warn(
            `Subscription ${subscription.id} payment failed - status set to PAST_DUE`,
        );

        // TODO: Send notification email to user
    }

    /**
     * Handle customer.subscription.updated
     */
    private async handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
        const stripeSubscription = event.data.object as Stripe.Subscription;

        const subscription = await this.prisma.subscription.findUnique({
            where: { stripeSubscriptionId: stripeSubscription.id },
        });

        if (!subscription) {
            this.logger.warn(
                `Subscription not found for update: ${stripeSubscription.id}`,
            );
            return;
        }

        // Extract properties (handle both old and new Stripe SDK versions)
        const stripeStatus = stripeSubscription.status;
        const periodStart = (stripeSubscription as any).current_period_start;
        const periodEnd = (stripeSubscription as any).current_period_end;
        const cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
        const canceledAt = stripeSubscription.canceled_at;
        const quantity = stripeSubscription.items.data[0]?.quantity || 1;

        // Map Stripe status to our status
        let status: SubscriptionStatus;
        switch (stripeStatus) {
            case 'active':
                status = SubscriptionStatus.ACTIVE;
                break;
            case 'past_due':
                status = SubscriptionStatus.PAST_DUE;
                break;
            case 'canceled':
                status = SubscriptionStatus.CANCELED;
                break;
            case 'trialing':
                status = SubscriptionStatus.TRIALING;
                break;
            case 'paused':
                status = SubscriptionStatus.PAUSED;
                break;
            default:
                status = SubscriptionStatus.ACTIVE;
        }

        await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
                status,
                currentPeriodStart: new Date(periodStart * 1000),
                currentPeriodEnd: new Date(periodEnd * 1000),
                cancelAtPeriodEnd,
                canceledAt: canceledAt ? new Date(canceledAt * 1000) : null,
                seatCount: quantity,
            },
        });

        this.logger.log(
            `Updated subscription ${subscription.id} - status: ${status}`,
        );
    }

    /**
     * Handle customer.subscription.deleted
     */
    private async handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
        const stripeSubscription = event.data.object as Stripe.Subscription;

        const subscription = await this.prisma.subscription.findUnique({
            where: { stripeSubscriptionId: stripeSubscription.id },
        });

        if (!subscription) {
            return;
        }

        await this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
                status: SubscriptionStatus.CANCELED,
                canceledAt: new Date(),
            },
        });

        this.logger.log(`Subscription ${subscription.id} deleted/canceled`);
    }

    /**
     * Handle charge.dispute.created (chargeback)
     */
    private async handleDisputeCreated(event: Stripe.Event): Promise<void> {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId =
            typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;

        if (!chargeId) {
            this.logger.error(`No charge ID in dispute ${dispute.id}`);
            return;
        }

        // Find the owner from the charge
        const charge = await this.stripeService.getCharge(chargeId);
        const owner = await this.stripeService.findOwnerByCustomerId(
            charge.customer as string,
        );

        if (!owner) {
            this.logger.error(`Could not find owner for disputed charge ${chargeId}`);
            return;
        }

        // Lock the wallet
        await this.walletService.lockWallet(
            owner.ownerType,
            owner.ownerId,
            `Chargeback dispute: ${dispute.reason}`,
            dispute.id,
        );

        this.logger.warn(
            `Wallet locked due to dispute ${dispute.id} for ${owner.ownerType}:${owner.ownerId}`,
        );

        // TODO: Send notification to user about dispute
    }

    /**
     * Handle charge.dispute.closed
     */
    private async handleDisputeClosed(event: Stripe.Event): Promise<void> {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId =
            typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;

        if (!chargeId) {
            return;
        }

        const charge = await this.stripeService.getCharge(chargeId);
        const owner = await this.stripeService.findOwnerByCustomerId(
            charge.customer as string,
        );

        if (!owner) {
            return;
        }

        if (dispute.status === 'won') {
            // Dispute resolved in our favor - unlock wallet
            await this.walletService.unlockWallet(
                owner.ownerType,
                owner.ownerId,
                `Dispute ${dispute.id} won`,
            );
            this.logger.log(`Wallet unlocked - dispute ${dispute.id} won`);
        } else if (dispute.status === 'lost') {
            // Dispute lost - deduct from wallet and keep locked until review
            const disputeAmount = dispute.amount;

            // Record chargeback deduction
            await this.prisma.walletLedger.create({
                data: {
                    userId: owner.ownerType === 'user' ? owner.ownerId : null,
                    organizationId: owner.ownerType === 'org' ? owner.ownerId : null,
                    txType: WalletTxType.CHARGEBACK,
                    amountCents: BigInt(-disputeAmount),
                    balanceAfter: BigInt(0), // Will be updated on unlock
                    stripePaymentId: dispute.id,
                    description: `Chargeback lost: ${dispute.reason}`,
                },
            });

            this.logger.warn(
                `Dispute ${dispute.id} lost - chargeback of ${disputeAmount} cents recorded`,
            );

            // TODO: Notify user about lost dispute
        }
    }

    /**
     * Handle charge.refunded
     */
    private async handleRefund(event: Stripe.Event): Promise<void> {
        const charge = event.data.object as Stripe.Charge;

        // Only process if there's a refund
        if (!charge.refunded && charge.amount_refunded === 0) {
            return;
        }

        const owner = await this.stripeService.findOwnerByCustomerId(
            charge.customer as string,
        );

        if (!owner) {
            this.logger.warn(`Could not find owner for refunded charge ${charge.id}`);
            return;
        }

        // Note: This is for Stripe-initiated refunds (admin refunds, etc.)
        // Our TTFB=0 refunds are handled separately in the billing module

        this.logger.log(`Processed Stripe refund for charge ${charge.id}`);
    }

    /**
     * Get owner from metadata or customer lookup
     */
    private async getOwnerFromMetadata(
        metadata: CheckoutMetadata,
        customerId: string,
    ): Promise<{ type: 'user' | 'org'; id: string } | null> {
        // First try metadata
        if (metadata.organization_id) {
            return { type: 'org', id: metadata.organization_id };
        }

        if (metadata.user_id) {
            return { type: 'user', id: metadata.user_id };
        }

        // Fallback to customer lookup
        const owner = await this.stripeService.findOwnerByCustomerId(customerId);
        if (owner) {
            return { type: owner.ownerType, id: owner.ownerId };
        }

        return null;
    }
}
