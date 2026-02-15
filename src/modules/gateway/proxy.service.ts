import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { ModelService } from './model.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import {
  ModelInfo,
  ProxyContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  RequestEventData,
} from './interfaces/gateway.interfaces';
import { AuthContext } from '../auth/interfaces/auth.interfaces';
import { StreamMetricsWrapper, StreamMetrics, wrapStream } from './stream';

/**
 * Streaming result with metrics
 */
export interface StreamingResult {
  stream: StreamMetricsWrapper;
  getMetrics: () => Partial<StreamMetrics>;
  isRefundEligible: () => boolean;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  constructor(
    private readonly modelService: ModelService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly config: ConfigService,
  ) { }

  /**
   * Proxy a chat completion request
   */
  async proxyChatCompletion(
    request: ChatCompletionRequest,
    authContext: AuthContext,
    requestId: string,
    clientIp?: string,
    userAgent?: string,
  ): Promise<{
    response?: ChatCompletionResponse;
    stream?: StreamMetricsWrapper;
    streamingResult?: StreamingResult;
    eventData: Partial<RequestEventData>;
  }> {
    const startTime = Date.now();
    const isStreaming = request.stream === true;

    // Get model info
    const model = await this.modelService.getModelOrThrow(request.model);

    // Get provider config
    const provider = this.modelService.getProvider(model.provider);
    if (!provider) {
      throw new HttpException(
        {
          error: {
            message: `Provider '${model.provider}' not configured`,
            type: 'api_error',
            code: 'provider_not_configured',
          },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Check circuit breaker
    await this.circuitBreaker.checkCircuit(model.provider);

    // Validate streaming capability
    if (isStreaming && !model.supportsStreaming) {
      throw new HttpException(
        {
          error: {
            message: `Model '${model.modelId}' does not support streaming`,
            type: 'invalid_request_error',
            code: 'streaming_not_supported',
            param: 'stream',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Validate request constraints
    this.validateRequest(request, authContext, model);

    // Build proxy context
    const proxyContext: ProxyContext = {
      requestId,
      model,
      provider,
      isStreaming,
      startTime,
    };

    // Prepare the upstream request
    const upstreamRequest = this.buildUpstreamRequest(request, model);
    const inputBytes = JSON.stringify(upstreamRequest).length;

    // Base event data
    const baseEventData: Partial<RequestEventData> = {
      requestId,
      ownerType: authContext.ownerType,
      ownerId: authContext.ownerId,
      projectId: authContext.projectId,
      apiKeyId: authContext.apiKeyId,
      model: model.modelId,
      provider: model.provider,
      endpoint: '/v1/chat/completions',
      isStreaming,
      inputBytes,
      clientIp,
      userAgent,
    };

    try {
      if (isStreaming) {
        const streamingResult = await this.proxyStreamingRequest(
          upstreamRequest,
          proxyContext,
        );
        return {
          stream: streamingResult.stream,
          streamingResult,
          eventData: baseEventData,
        };
      } else {
        const { response, latencyMs, ttfbMs, outputBytes, usage } =
          await this.proxyNonStreamingRequest(upstreamRequest, proxyContext);

        // Record success
        await this.circuitBreaker.recordSuccess(model.provider);

        return {
          response,
          eventData: {
            ...baseEventData,
            status: 'SUCCESS',
            statusCode: 200,
            latencyMs,
            ttfbMs,
            outputBytes,
            inputTokens: usage?.prompt_tokens,
            outputTokens: usage?.completion_tokens,
          },
        };
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      // Record failure for circuit breaker
      if (this.isUpstreamError(error)) {
        await this.circuitBreaker.recordFailure(model.provider);
      }

      // Build error event data
      const errorEventData: Partial<RequestEventData> = {
        ...baseEventData,
        latencyMs,
        status: this.getErrorStatus(error),
        statusCode: this.getErrorStatusCode(error),
        errorType: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        outputBytes: 0,
      };

      throw Object.assign(error, { eventData: errorEventData });
    }
  }

  /**
   * Validate request against policy constraints
   */
  private validateRequest(
    request: ChatCompletionRequest,
    authContext: AuthContext,
    model: ModelInfo,
  ): void {
    const { policy } = authContext;

    // Check max_tokens
    if (request.max_tokens && request.max_tokens > policy.maxOutputTokens) {
      throw new HttpException(
        {
          error: {
            message: `max_tokens (${request.max_tokens}) exceeds plan limit (${policy.maxOutputTokens})`,
            type: 'invalid_request_error',
            code: 'max_tokens_exceeded',
            param: 'max_tokens',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Check model output limit
    if (request.max_tokens && request.max_tokens > model.maxOutputTokens) {
      throw new HttpException(
        {
          error: {
            message: `max_tokens (${request.max_tokens}) exceeds model limit (${model.maxOutputTokens})`,
            type: 'invalid_request_error',
            code: 'max_tokens_exceeded',
            param: 'max_tokens',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Estimate input tokens (rough estimate based on message length)
    const estimatedInputTokens = this.estimateTokens(request.messages);
    if (estimatedInputTokens > policy.maxInputTokens) {
      throw new HttpException(
        {
          error: {
            message: `Estimated input tokens (${estimatedInputTokens}) exceeds plan limit (${policy.maxInputTokens})`,
            type: 'invalid_request_error',
            code: 'input_tokens_exceeded',
            param: 'messages',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Check streaming permission
    if (request.stream && !policy.hasStreaming) {
      throw new HttpException(
        {
          error: {
            message: 'Streaming is not available on your plan',
            type: 'invalid_request_error',
            code: 'streaming_not_allowed',
            param: 'stream',
          },
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Build upstream request with model mapping
   */
  private buildUpstreamRequest(
    request: ChatCompletionRequest,
    model: ModelInfo,
  ): ChatCompletionRequest {
    return {
      ...request,
      model: model.upstreamModelId, // Map to upstream model ID
    };
  }

  /**
   * Proxy non-streaming request
   */
  private async proxyNonStreamingRequest(
    request: ChatCompletionRequest,
    context: ProxyContext,
  ): Promise<{
    response: ChatCompletionResponse;
    latencyMs: number;
    ttfbMs: number;
    outputBytes: number;
    usage?: ChatCompletionResponse['usage'];
  }> {
    const { provider, requestId } = context;
    const url = `${provider.baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, provider.timeout.read);

    let ttfbTime: number | undefined;

    try {
      const fetchStart = Date.now();

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'X-Request-ID': requestId,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      ttfbTime = Date.now() - fetchStart;

      if (!response.ok) {
        const errorBody = await response.text();
        throw new HttpException(
          this.parseUpstreamError(errorBody, response.status),
          response.status,
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const latencyMs = Date.now() - context.startTime;
      const outputBytes = JSON.stringify(data).length;

      return {
        response: data,
        latencyMs,
        ttfbMs: ttfbTime,
        outputBytes,
        usage: data.usage,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Proxy streaming request with metrics tracking
   */
  private async proxyStreamingRequest(
    request: ChatCompletionRequest,
    context: ProxyContext,
  ): Promise<StreamingResult> {
    const { provider, requestId, model } = context;
    const url = `${provider.baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const maxDuration = this.config.get<number>('STREAM_MAX_DURATION_MS', 300000);

    const timeout = setTimeout(() => {
      controller.abort();
    }, maxDuration);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'X-Request-ID': requestId,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timeout);
        const errorBody = await response.text();
        throw new HttpException(
          this.parseUpstreamError(errorBody, response.status),
          response.status,
        );
      }

      if (!response.body) {
        clearTimeout(timeout);
        throw new HttpException(
          {
            error: {
              message: 'No response body from upstream',
              type: 'api_error',
              code: 'no_response_body',
            },
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      // Convert web stream to Node readable
      const reader = response.body.getReader();
      const rawReadable = new Readable({
        async read() {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTimeout(timeout);
              this.push(null);
            } else {
              this.push(Buffer.from(value));
            }
          } catch (error) {
            clearTimeout(timeout);
            this.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        },
        destroy(err, callback) {
          clearTimeout(timeout);
          reader.cancel().catch(() => { });
          callback(err);
        },
      });

      // Wrap with metrics tracking using helper function
      const metricsWrapper = wrapStream(rawReadable, requestId, {
        maxDurationMs: maxDuration,
        onFirstChunk: (ttfbMs: number) => {
          this.logger.debug(`Stream TTFB for ${requestId}: ${ttfbMs}ms`);
        },
        onMetrics: (metrics: StreamMetrics) => {
          if (metrics.status === 'COMPLETED') {
            this.logger.debug(
              `Stream completed for ${requestId}: ` +
              `status=${metrics.status}, chunks=${metrics.chunkCount}, bytes=${metrics.outputBytes}`,
            );
            // Record success for circuit breaker
            this.circuitBreaker.recordSuccess(model.provider).catch(() => { });
          } else if (metrics.status === 'UPSTREAM_ERROR' || metrics.status === 'TIMEOUT') {
            this.logger.warn(
              `Stream error for ${requestId}: ${metrics.errorMessage}, ` +
              `status=${metrics.status}, ttfb=${metrics.ttfbMs}`,
            );
            // Record failure for circuit breaker
            this.circuitBreaker.recordFailure(model.provider).catch(() => { });
          }
        },
        onError: (error: Error) => {
          this.logger.warn(`Stream error for ${requestId}: ${error.message}`);
        },
      });

      return {
        stream: metricsWrapper,
        getMetrics: () => metricsWrapper.getMetrics(),
        isRefundEligible: () => metricsWrapper.isRefundEligible(),
      };
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  }

  /**
   * Parse upstream error response
   */
  private parseUpstreamError(
    body: string,
    statusCode: number,
  ): { error: { message: string; type: string; code: string } } {
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) {
        return {
          error: {
            message: parsed.error.message || 'Upstream error',
            type: parsed.error.type || 'api_error',
            code: parsed.error.code || 'upstream_error',
          },
        };
      }
    } catch {
      // Not JSON
    }

    return {
      error: {
        message: `Upstream error (${statusCode}): ${body.substring(0, 200)}`,
        type: 'api_error',
        code: 'upstream_error',
      },
    };
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(messages: ChatCompletionRequest['messages']): number {
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      }
      if (msg.name) chars += msg.name.length;
    }
    // Rough estimate: ~4 chars per token
    return Math.ceil(chars / 4);
  }

  /**
   * Check if error is from upstream
   */
  private isUpstreamError(error: unknown): boolean {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return status >= 500 || status === 429;
    }
    return (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('timeout'))
    );
  }

  /**
   * Get error status for event
   */
  private getErrorStatus(error: unknown): RequestEventData['status'] {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status >= 500) return 'UPSTREAM_ERROR';
      if (status === 429) return 'RATE_LIMITED';
      if (status === 402) return 'BILLING_BLOCKED';
      return 'CLIENT_ERROR';
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return 'TIMEOUT';
    }
    return 'UPSTREAM_ERROR';
  }

  /**
   * Get error status code
   */
  private getErrorStatusCode(error: unknown): number {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return 504;
    }
    return 500;
  }
}