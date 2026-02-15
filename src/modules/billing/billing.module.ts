import { Module, Global } from '@nestjs/common';
import { BillingService } from './billing.service';
import { WalletService } from './wallet.service';
import { ModelPricingService } from './model-pricing.service';
import { RefundService } from './refund.service';
import { BillingGuard } from './guards/billing.guard';

/**
 * Billing Module
 * Provides allowance-or-wallet billing with per-model pricing
 *
 * Global module - available throughout the application
 */
@Global()
@Module({
  providers: [
    BillingService,
    WalletService,
    ModelPricingService,
    RefundService,
    BillingGuard,
  ],
  exports: [
    BillingService,
    WalletService,
    ModelPricingService,
    RefundService,
    BillingGuard,
  ],
})
export class BillingModule { }