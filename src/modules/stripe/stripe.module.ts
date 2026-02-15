import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookProcessor } from './stripe-webhook.processor';
import { STRIPE_QUEUES } from './interfaces/stripe.interfaces';
import { BillingModule } from '../billing/billing.module';

@Module({
    imports: [
        BullModule.registerQueue({
            name: STRIPE_QUEUES.WEBHOOKS,
        }),
        BillingModule,
    ],
    controllers: [StripeWebhookController],
    providers: [StripeService, StripeWebhookProcessor],
    exports: [StripeService],
})
export class StripeModule { }