import { Controller, Post, Req, Headers, BadRequestException, Logger, RawBodyRequest } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { StripeService } from './stripe.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STRIPE_QUEUES, STRIPE_JOBS, StripeWebhookJobData } from './interfaces/stripe.interfaces';

@Controller('webhooks/stripe')
export class StripeWebhookController {
    private readonly logger = new Logger(StripeWebhookController.name);

    constructor(
        private readonly stripeService: StripeService,
        private readonly prisma: PrismaService,
        @InjectQueue(STRIPE_QUEUES.WEBHOOKS) private readonly webhookQueue: Queue,
    ) { }

    @Post()
    async handleWebhook(
        @Req() req: RawBodyRequest<FastifyRequest>,
        @Headers('stripe-signature') signature: string,
    ): Promise<{ received: boolean }> {
        if (!signature) {
            throw new BadRequestException('Missing stripe-signature header');
        }

        // Get raw body for signature verification
        const rawBody = req.rawBody;
        if (!rawBody) {
            throw new BadRequestException('Missing raw body - ensure rawBody parsing is enabled');
        }

        // Verify signature and construct event
        let event;
        try {
            event = this.stripeService.constructWebhookEvent(rawBody, signature);
        } catch (err) {
            this.logger.warn(`Webhook signature verification failed: ${err.message}`);
            throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
        }

        this.logger.log(`Received Stripe webhook: ${event.type} (${event.id})`);

        // Check for idempotency - have we already processed this event?
        const existingEvent = await this.prisma.stripeEvent.findUnique({
            where: { stripeEventId: event.id },
        });

        if (existingEvent) {
            if (existingEvent.processed) {
                this.logger.log(`Event ${event.id} already processed, skipping`);
                return { received: true };
            }
            // Event exists but not processed - it might be in queue or failed
            // We'll let the queue handle deduplication
        } else {
            // Store event for idempotency tracking
            await this.prisma.stripeEvent.create({
                data: {
                    stripeEventId: event.id,
                    eventType: event.type,
                    payload: event as unknown as object,
                    processed: false,
                },
            });
        }

        // Queue for async processing
        const jobData: StripeWebhookJobData = {
            stripeEventId: event.id,
            eventType: event.type,
            payload: event,
        };

        await this.webhookQueue.add(STRIPE_JOBS.PROCESS_WEBHOOK, jobData, {
            jobId: event.id, // Ensures idempotency at queue level
            attempts: 5,
            backoff: {
                type: 'exponential',
                delay: 1000,
            },
            removeOnComplete: {
                age: 86400, // Keep completed jobs for 24 hours
                count: 1000,
            },
            removeOnFail: {
                age: 604800, // Keep failed jobs for 7 days
            },
        });

        this.logger.log(`Queued webhook event ${event.id} for processing`);

        // Return 200 immediately - processing happens async
        return { received: true };
    }
}