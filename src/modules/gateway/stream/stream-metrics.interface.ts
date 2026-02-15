/**
 * Stream metrics collected during streaming response
 */
export interface StreamMetrics {
  /** Request ID */
  requestId: string;
  
  /** Time to first byte in milliseconds (null if no data received) */
  ttfbMs: number | null;
  
  /** Total latency in milliseconds */
  totalLatencyMs: number;
  
  /** Number of SSE chunks received */
  chunkCount: number;
  
  /** Total output bytes */
  outputBytes: number;
  
  /** Stream completion status */
  status: StreamStatus;
  
  /** Error message if status is ERROR */
  errorMessage?: string;
  
  /** Upstream HTTP status code (if available) */
  upstreamStatus?: number;
  
  /** Token usage from final chunk (if available) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

/**
 * Stream completion status
 */
export type StreamStatus = 
  | 'COMPLETED'      // Stream finished successfully with [DONE]
  | 'CLIENT_ABORT'   // Client disconnected
  | 'UPSTREAM_ERROR' // Upstream returned error
  | 'TIMEOUT'        // Stream duration exceeded limit
  | 'ERROR';         // Generic error

/**
 * Options for stream wrapper
 */
export interface StreamWrapperOptions {
  /** Maximum stream duration in milliseconds */
  maxDurationMs: number;
  
  /** Callback when stream metrics are available */
  onMetrics?: (metrics: StreamMetrics) => void;
  
  /** Callback when first chunk received */
  onFirstChunk?: (ttfbMs: number) => void;
  
  /** Callback on stream error */
  onError?: (error: Error) => void;
}

/**
 * Parsed SSE event
 */
export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * OpenAI streaming chunk
 */
export interface StreamingChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      function_call?: object;
      tool_calls?: object[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}