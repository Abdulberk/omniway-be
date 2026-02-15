import { Transform, TransformCallback, Readable } from 'stream';
import { Logger } from '@nestjs/common';
import {
  StreamMetrics,
  StreamStatus,
  StreamWrapperOptions,
  StreamingChunk,
} from './stream-metrics.interface';

/**
 * Stream wrapper that tracks TTFB, chunk count, output bytes, and usage
 * Wraps an upstream ReadableStream and passes through data while collecting metrics
 */
export class StreamMetricsWrapper extends Transform {
  private readonly logger = new Logger(StreamMetricsWrapper.name);
  
  private readonly requestId: string;
  private readonly startTime: number;
  private readonly maxDurationMs: number;
  private readonly onMetrics?: (metrics: StreamMetrics) => void;
  private readonly onFirstChunk?: (ttfbMs: number) => void;
  private readonly onError?: (error: Error) => void;
  
  // Metrics state
  private ttfbMs: number | null = null;
  private chunkCount = 0;
  private outputBytes = 0;
  private status: StreamStatus = 'COMPLETED';
  private errorMessage?: string;
  private upstreamStatus?: number;
  private usage?: { promptTokens: number; completionTokens: number };
  
  // Buffer for incomplete SSE events
  private buffer = '';
  
  // Timeout handle
  private timeoutHandle?: NodeJS.Timeout;
  
  // Flag to prevent double-finish
  private metricsEmitted = false;

  constructor(
    requestId: string,
    options: StreamWrapperOptions,
  ) {
    super();
    this.requestId = requestId;
    this.startTime = Date.now();
    this.maxDurationMs = options.maxDurationMs;
    this.onMetrics = options.onMetrics;
    this.onFirstChunk = options.onFirstChunk;
    this.onError = options.onError;
    
    // Set up max duration timeout
    this.timeoutHandle = setTimeout(() => {
      this.handleTimeout();
    }, this.maxDurationMs);
  }

  /**
   * Transform incoming data
   */
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const now = Date.now();
      
      // Record TTFB on first chunk
      if (this.ttfbMs === null) {
        this.ttfbMs = now - this.startTime;
        this.logger.debug(`TTFB: ${this.ttfbMs}ms for request ${this.requestId}`);
        this.onFirstChunk?.(this.ttfbMs);
      }
      
      // Track metrics
      this.outputBytes += chunk.length;
      
      // Parse SSE events for chunk count and usage
      this.parseSSEChunks(chunk.toString('utf-8'));
      
      // Pass through the data unchanged
      callback(null, chunk);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handle stream flush (completion)
   */
  _flush(callback: TransformCallback): void {
    this.clearTimeout();
    
    // Process any remaining buffer
    if (this.buffer.trim()) {
      this.processLine(this.buffer);
    }
    
    this.emitMetrics();
    callback();
  }

  /**
   * Handle stream destruction
   */
  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.clearTimeout();
    
    if (error) {
      this.status = 'ERROR';
      this.errorMessage = error.message;
      this.logger.warn(
        `Stream destroyed with error for ${this.requestId}: ${error.message}`,
      );
      this.onError?.(error);
    }
    
    this.emitMetrics();
    callback(error);
  }

  /**
   * Handle client abort
   */
  handleClientAbort(): void {
    this.status = 'CLIENT_ABORT';
    this.logger.debug(`Client aborted stream ${this.requestId}`);
    this.destroy();
  }

  /**
   * Handle upstream error
   */
  handleUpstreamError(statusCode: number, message: string): void {
    this.status = 'UPSTREAM_ERROR';
    this.upstreamStatus = statusCode;
    this.errorMessage = message;
    this.destroy(new Error(message));
  }

  /**
   * Handle timeout
   */
  private handleTimeout(): void {
    this.status = 'TIMEOUT';
    this.errorMessage = `Stream exceeded max duration of ${this.maxDurationMs}ms`;
    this.logger.warn(`Stream timeout for ${this.requestId}`);
    this.destroy(new Error(this.errorMessage));
  }

  /**
   * Clear timeout if set
   */
  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  /**
   * Parse SSE chunks from incoming data
   */
  private parseSSEChunks(data: string): void {
    this.buffer += data;
    
    // Split by double newline (SSE event separator)
    const lines = this.buffer.split('\n');
    
    // Keep the last potentially incomplete line in buffer
    this.buffer = lines.pop() || '';
    
    // Process complete lines
    for (const line of lines) {
      this.processLine(line);
    }
  }

  /**
   * Process a single SSE line
   */
  private processLine(line: string): void {
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith(':')) {
      return;
    }
    
    // Parse data line
    if (trimmed.startsWith('data:')) {
      const dataContent = trimmed.slice(5).trim();
      
      // Check for [DONE] marker
      if (dataContent === '[DONE]') {
        this.status = 'COMPLETED';
        return;
      }
      
      // Try to parse JSON chunk
      try {
        const chunk = JSON.parse(dataContent) as StreamingChunk;
        this.chunkCount++;
        
        // Extract usage from final chunk (if present)
        if (chunk.usage) {
          this.usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
        
        // Check for finish_reason to update status
        if (chunk.choices?.[0]?.finish_reason) {
          this.status = 'COMPLETED';
        }
      } catch {
        // Not valid JSON - might be partial or malformed
        this.logger.debug(`Non-JSON SSE data: ${dataContent.slice(0, 100)}`);
      }
    }
  }

  /**
   * Emit final metrics
   */
  private emitMetrics(): void {
    if (this.metricsEmitted) {
      return;
    }
    this.metricsEmitted = true;
    
    const metrics: StreamMetrics = {
      requestId: this.requestId,
      ttfbMs: this.ttfbMs,
      totalLatencyMs: Date.now() - this.startTime,
      chunkCount: this.chunkCount,
      outputBytes: this.outputBytes,
      status: this.status,
      errorMessage: this.errorMessage,
      upstreamStatus: this.upstreamStatus,
      usage: this.usage,
    };
    
    this.logger.debug(
      `Stream metrics for ${this.requestId}: TTFB=${this.ttfbMs}ms, chunks=${this.chunkCount}, bytes=${this.outputBytes}, status=${this.status}`,
    );
    
    this.onMetrics?.(metrics);
  }

  /**
   * Get current metrics (for in-flight inspection)
   */
  getMetrics(): Partial<StreamMetrics> {
    return {
      requestId: this.requestId,
      ttfbMs: this.ttfbMs,
      totalLatencyMs: Date.now() - this.startTime,
      chunkCount: this.chunkCount,
      outputBytes: this.outputBytes,
      status: this.status,
    };
  }

  /**
   * Check if stream received any data (for refund eligibility)
   */
  hasReceivedData(): boolean {
    return this.ttfbMs !== null;
  }

  /**
   * Check if eligible for refund (TTFB=0 / null)
   */
  isRefundEligible(): boolean {
    return this.ttfbMs === null && this.status !== 'COMPLETED' && this.status !== 'CLIENT_ABORT';
  }
}

/**
 * Create a stream wrapper around an upstream readable
 */
export function wrapStream(
  upstream: Readable,
  requestId: string,
  options: StreamWrapperOptions,
): StreamMetricsWrapper {
  const wrapper = new StreamMetricsWrapper(requestId, options);
  
  // Handle upstream errors
  upstream.on('error', (error) => {
    wrapper.handleUpstreamError(500, error.message);
  });
  
  // Pipe upstream through wrapper
  upstream.pipe(wrapper);
  
  return wrapper;
}