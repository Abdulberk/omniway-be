import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { BillingService } from '../billing.service';
import { AuthContext } from '../../auth/interfaces/auth.interfaces';
import { toBillingOwnerType } from '../interfaces/billing.interfaces';

/**
 * Billing result attached to request
 */
export interface BillingResultInfo {
  source: 'allowance' | 'wallet';
  chargedCents: number;
  allowanceRemaining: number;
  walletBalanceCents: string;
}

/**
 * Request extension for billing context
 */
export interface RequestWithBilling extends FastifyRequest {
  authContext: AuthContext;
  _requestId: string;
  _model?: string;
  billingResult?: BillingResultInfo;
}

/**
 * Billing Guard
 * Enforces allowance-or-wallet billing before request processing
 * 
 * Guard Order: Auth → RateLimit → Concurrency → ModelAccess → BillingGuard → Proxy
 */
@Injectable()
export class BillingGuard implements CanActivate {
  private readonly logger = new Logger(BillingGuard.name);

  constructor(private readonly billingService: BillingService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & { authContext: AuthContext; _requestId: string; _model: string }
    >();

    const authContext = request.authContext;
    if (!authContext) {
      throw new HttpException(
        {
          error: {
            message: 'Authentication context not found',
            type: 'auth_error',
            code: 'missing_auth_context',
          },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Get model from request body or resolved model
    const body = request.body as { model?: string } | undefined;
    const model = request._model || body?.model;

    if (!model) {
      throw new HttpException(
        {
          error: {
            message: 'Model is required for billing',
            type: 'invalid_request_error',
            code: 'missing_model',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Get or generate request ID
    const requestId = request._requestId || 
      (request.headers['x-request-id'] as string) ||
      (request.headers['idempotency-key'] as string) ||
      this.generateRequestId();

    // Attach request ID for later use
    request._requestId = requestId;

    try {
      const result = await this.billingService.chargeBilling(authContext, requestId, model);

      // Handle billing result
      switch (result.code) {
        case 0:
          // Insufficient funds
          return this.handleInsufficientFunds(result, authContext);

        case 1:
          // Success - attach billing info to request
          (request as unknown as RequestWithBilling).billingResult = {
            source: result.source as 'allowance' | 'wallet',
            chargedCents: result.chargedCents,
            allowanceRemaining: result.allowanceRemaining,
            walletBalanceCents: result.walletBalanceCents,
          };
          return true;

        case 2:
          // Idempotent hit - already processed
          // For streaming requests, return 409 Conflict
          const isStreaming = (request.body as { stream?: boolean })?.stream === true;
          if (isStreaming) {
            throw new HttpException(
              {
                error: {
                  message: 'Streaming request already processed. Use a new Idempotency-Key for retries.',
                  type: 'idempotency_error',
                  code: 'idempotency_conflict',
                  request_id: requestId,
                },
              },
              HttpStatus.CONFLICT,
            );
          }
          
          // For non-streaming, attach billing info (will try to serve cached response)
          (request as unknown as RequestWithBilling).billingResult = {
            source: result.source as 'allowance' | 'wallet',
            chargedCents: result.chargedCents,
            allowanceRemaining: result.allowanceRemaining,
            walletBalanceCents: result.walletBalanceCents,
          };
          return true;

        default:
          this.logger.error(`Unknown billing result code: ${result.code}`);
          throw new HttpException(
            {
              error: {
                message: 'Billing system error',
                type: 'api_error',
                code: 'billing_error',
              },
            },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        `Billing check failed for ${toBillingOwnerType(authContext.ownerType)}:${authContext.ownerId}`,
        error,
      );

      throw new HttpException(
        {
          error: {
            message: 'Billing system temporarily unavailable',
            type: 'api_error',
            code: 'billing_unavailable',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Handle insufficient funds response
   */
  private handleInsufficientFunds(
    result: { source: string; chargedCents: number; walletBalanceCents: string },
    authContext: AuthContext,
  ): never {
    if (result.source === 'locked') {
      throw new HttpException(
        {
          error: {
            message: 'Your account is temporarily locked due to a payment dispute. Please contact support.',
            type: 'account_locked',
            code: 'dispute_pending',
            support_url: 'https://support.omniway.ai',
          },
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Insufficient wallet balance
    const upgradeUrl = 'https://app.omniway.ai/billing';
    
    throw new HttpException(
      {
        error: {
          message: 'Daily allowance depleted and insufficient wallet balance. Please top-up or upgrade.',
          type: 'insufficient_wallet',
          code: 'payment_required',
          wallet_balance_cents: result.walletBalanceCents,
          required_cents: String(result.chargedCents),
          upgrade_url: upgradeUrl,
          plan: authContext.policy.planSlug,
        },
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `req_${timestamp}${random}`;
  }
}