import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import { ConcurrencyGuard } from '../rate-limit/guards/concurrency.guard';
import { ModelAccessGuard } from './guards/model-access.guard';
import {
  BillingGuard,
  RequestWithBilling,
} from '../billing/guards/billing.guard';
import { ProxyService } from './proxy.service';
import { ModelService } from './model.service';
import { RefundService } from '../billing/refund.service';
import {
  UsageService,
  RequestCompletedEvent,
  determineRequestStatus,
} from '../usage';
import { toBillingOwnerType } from '../billing/interfaces/billing.interfaces';
import {
  ChatCompletionRequest,
  ModelsListResponse,
} from './interfaces/gateway.interfaces';
import { AuthContext } from '../auth/interfaces/auth.interfaces';
import { v4 as uuidv4 } from 'uuid';

/**
 * Gateway controller for OpenAI-compatible API endpoints
 * Guard order: Auth → RateLimit → Concurrency → ModelAccess → Billing → Proxy
 */
@Controller('v1')
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);

  constructor(
    private readonly proxyService: ProxyService,
    private readonly modelService: ModelService,
    private readonly refundService: RefundService,
    private readonly usageService: UsageService,
  ) { }

  /**
   * POST /v1/chat/completions
   * OpenAI-compatible chat completion endpoint
   */
  @Post('chat/completions')
  @UseGuards(
    AuthGuard,
    RateLimitGuard,
    ConcurrencyGuard,
    ModelAccessGuard,
    BillingGuard,
  )
  async chatCompletions(
    @Body() body: ChatCompletionRequest,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Use request ID from BillingGuard if available (for idempotency tracking)
    const reqWithBilling = request as unknown as RequestWithBilling;
    const requestId = reqWithBilling._requestId || uuidv4();
    const authContext = reqWithBilling.authContext;

    const clientIp = this.getClientIp(request);
    const userAgent = request.headers['user-agent'] as string | undefined;
    const startTime = Date.now();

    // Add request ID to response headers
    reply.header('x-request-id', requestId);

    // Get model info for event
    const modelInfo = await this.modelService.getModel(body.model);
    const provider = modelInfo?.provider || 'unknown';

    try {
      const result = await this.proxyService.proxyChatCompletion(
        body,
        authContext,
        requestId,
        clientIp,
        userAgent,
      );

      if (result.stream && result.streamingResult) {
        // Streaming response
        reply.header('Content-Type', 'text/event-stream');
        reply.header('Cache-Control', 'no-cache');
        reply.header('Connection', 'keep-alive');
        reply.header('Transfer-Encoding', 'chunked');

        // Handle client disconnect for abort detection
        const onClose = () => {
          if (result.streamingResult) {
            const metrics = result.streamingResult.getMetrics();
            this.logger.debug(
              `Client disconnected, stream status: ${metrics.status}, ttfb: ${metrics.ttfbMs}`,
            );
          }
        };
        request.raw.on('close', onClose);

        // Pipe the stream to the response
        await reply.send(result.stream);

        // Get stream metrics after completion
        const streamMetrics = result.streamingResult.getMetrics();
        const latencyMs = Date.now() - startTime;

        // After stream ends, check for refund eligibility
        if (
          result.streamingResult.isRefundEligible() &&
          reqWithBilling.billingResult
        ) {
          const { billingResult } = reqWithBilling;

          // Only refund wallet charges (not allowance)
          if (
            billingResult.source === 'wallet' &&
            billingResult.chargedCents > 0
          ) {
            const billingOwnerType = toBillingOwnerType(authContext.ownerType);

            this.logger.log(
              `Processing refund for TTFB=0 failure: request ${requestId}, ` +
              `amount: ${billingResult.chargedCents} cents`,
            );

            const refundResult = await this.refundService.processRefund({
              ownerType: billingOwnerType,
              ownerId: authContext.ownerId,
              requestId,
              amountCents: billingResult.chargedCents,
              reason: 'Upstream failure (TTFB=0)',
              wasWalletCharge: true,
            });

            if (refundResult.status === 'SUCCESS') {
              this.logger.log(
                `Refund processed for ${requestId}: ${billingResult.chargedCents} cents`,
              );
            } else if (refundResult.status === 'DAILY_CAP_EXCEEDED') {
              this.logger.warn(
                `Refund cap exceeded for ${billingOwnerType}:${authContext.ownerId}`,
              );
            } else if (refundResult.status !== 'ALREADY_REFUNDED') {
              this.logger.error(
                `Refund failed for ${requestId}: ${refundResult.status}`,
              );
            }
          }
        }

        // Emit event for async persistence
        const event: RequestCompletedEvent = {
          requestId,
          ownerType: authContext.ownerType,
          ownerId: authContext.ownerId,
          projectId: authContext.projectId,
          apiKeyId: authContext.apiKeyId,
          model: body.model,
          provider,
          endpoint: '/v1/chat/completions',
          status: determineRequestStatus(
            200,
            streamMetrics.status === 'COMPLETED'
              ? undefined
              : streamMetrics.status,
          ),
          statusCode: 200,
          latencyMs,
          ttfbMs: streamMetrics.ttfbMs ?? undefined,
          inputTokens: streamMetrics.usage?.promptTokens,
          outputTokens: streamMetrics.usage?.completionTokens,
          inputBytes: JSON.stringify(body).length,
          outputBytes: streamMetrics.outputBytes ?? 0,
          billingSource:
            reqWithBilling.billingResult?.source === 'allowance' ||
              reqWithBilling.billingResult?.source === 'wallet'
              ? reqWithBilling.billingResult.source
              : undefined,
          costCents: reqWithBilling.billingResult?.chargedCents,
          isStreaming: true,
          streamChunks: streamMetrics.chunkCount,
          clientIp,
          userAgent,
          timestamp: new Date(),
        };

        await this.usageService.emitRequestCompleted(event);
      } else if (result.response) {
        // Non-streaming response
        const latencyMs = Date.now() - startTime;

        reply.header('Content-Type', 'application/json');

        // Add usage headers for convenience
        if (result.response.usage) {
          reply.header(
            'x-prompt-tokens',
            String(result.response.usage.prompt_tokens),
          );
          reply.header(
            'x-completion-tokens',
            String(result.response.usage.completion_tokens),
          );
          reply.header(
            'x-total-tokens',
            String(result.response.usage.total_tokens),
          );
        }

        // Add billing info headers
        if (reqWithBilling.billingResult) {
          reply.header('x-billing-source', reqWithBilling.billingResult.source);
          reply.header(
            'x-billing-charged-cents',
            String(reqWithBilling.billingResult.chargedCents),
          );
          reply.header(
            'x-allowance-remaining',
            String(reqWithBilling.billingResult.allowanceRemaining),
          );
        }

        await reply.status(200).send(result.response);

        // Emit event for async persistence
        const responseStr = JSON.stringify(result.response);
        const event: RequestCompletedEvent = {
          requestId,
          ownerType: authContext.ownerType,
          ownerId: authContext.ownerId,
          projectId: authContext.projectId,
          apiKeyId: authContext.apiKeyId,
          model: body.model,
          provider,
          endpoint: '/v1/chat/completions',
          status: 'SUCCESS',
          statusCode: 200,
          latencyMs,
          inputTokens: result.response.usage?.prompt_tokens,
          outputTokens: result.response.usage?.completion_tokens,
          inputBytes: JSON.stringify(body).length,
          outputBytes: responseStr.length,
          billingSource:
            reqWithBilling.billingResult?.source === 'allowance' ||
              reqWithBilling.billingResult?.source === 'wallet'
              ? reqWithBilling.billingResult.source
              : undefined,
          costCents: reqWithBilling.billingResult?.chargedCents,
          isStreaming: false,
          clientIp,
          userAgent,
          timestamp: new Date(),
        };

        await this.usageService.emitRequestCompleted(event);
      }
    } catch (error) {
      // Emit error event for persistence
      const latencyMs = Date.now() - startTime;
      const statusCode =
        error instanceof HttpException ? error.getStatus() : 500;
      const errorType =
        error instanceof HttpException ? 'http_error' : 'internal_error';
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const event: RequestCompletedEvent = {
        requestId,
        ownerType: authContext.ownerType,
        ownerId: authContext.ownerId,
        projectId: authContext.projectId,
        apiKeyId: authContext.apiKeyId,
        model: body.model,
        provider,
        endpoint: '/v1/chat/completions',
        status: determineRequestStatus(statusCode, errorType),
        statusCode,
        errorType,
        errorMessage,
        latencyMs,
        inputBytes: JSON.stringify(body).length,
        outputBytes: 0,
        billingSource:
          reqWithBilling.billingResult?.source === 'allowance' ||
            reqWithBilling.billingResult?.source === 'wallet'
            ? reqWithBilling.billingResult.source
            : undefined,
        costCents: reqWithBilling.billingResult?.chargedCents,
        isStreaming: body.stream === true,
        clientIp,
        userAgent,
        timestamp: new Date(),
      };

      // Fire and forget - don't block error response
      this.usageService.emitRequestCompleted(event).catch((err) => {
        this.logger.error('Failed to emit error event:', err);
      });

      this.handleError(error, reply, requestId);
    }
  }

  /**
   * GET /v1/models
   * List available models
   */
  @Get('models')
  @UseGuards(AuthGuard)
  async listModels(
    @Req() request: FastifyRequest,
  ): Promise<ModelsListResponse> {
    const authContext = (
      request as FastifyRequest & { authContext: AuthContext }
    ).authContext;
    const { policy } = authContext;

    // Get all active models from ModelService
    const modelsResponse = await this.modelService.listModels();

    // Filter by plan's allowed models if allowlist is configured
    if (policy.allowedModels.length > 0) {
      const filteredData = modelsResponse.data.filter((m) =>
        policy.allowedModels.includes(m.id),
      );
      return {
        object: 'list',
        data: filteredData,
      };
    }

    return modelsResponse;
  }

  /**
   * GET /v1/models/:modelId
   * Get specific model info
   */
  @Get('models/:modelId')
  @UseGuards(AuthGuard)
  async getModel(@Req() request: FastifyRequest): Promise<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }> {
    const authContext = (
      request as FastifyRequest & { authContext: AuthContext }
    ).authContext;
    const { policy } = authContext;
    const modelId = (request.params as { modelId: string }).modelId;

    const model = await this.modelService.getModel(modelId);

    if (!model) {
      throw new HttpException(
        {
          error: {
            message: `Model '${modelId}' not found`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }

    // Check plan access
    if (
      policy.allowedModels.length > 0 &&
      !policy.allowedModels.includes(modelId)
    ) {
      throw new HttpException(
        {
          error: {
            message: `Model '${modelId}' is not available on your plan`,
            type: 'invalid_request_error',
            code: 'model_not_allowed',
          },
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return {
      id: model.modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: model.provider,
    };
  }

  /**
   * Extract client IP from request
   */
  private getClientIp(request: FastifyRequest): string {
    // Check common proxy headers
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips.split(',')[0].trim();
    }

    const realIp = request.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    return request.ip;
  }

  /**
   * Handle and format errors
   */
  private handleError(
    error: unknown,
    reply: FastifyReply,
    requestId: string,
  ): void {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const response = error.getResponse();

      reply.status(status).send({
        ...(typeof response === 'object'
          ? response
          : { error: { message: response } }),
        request_id: requestId,
      });
      return;
    }

    this.logger.error(
      `Unhandled error in gateway: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );

    reply.status(500).send({
      error: {
        message: 'Internal server error',
        type: 'api_error',
        code: 'internal_error',
      },
      request_id: requestId,
    });
  }
}
