/**
 * Model information from catalog
 */
export interface ModelInfo {
  modelId: string;
  provider: string;
  upstreamModelId: string;
  displayName: string;
  
  // Capabilities
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsToolCalls: boolean;
  supportsFunctionCall: boolean;
  supportsJson: boolean;
  
  // Limits
  maxContextTokens: number;
  maxOutputTokens: number;
  
  // Status
  isActive: boolean;
  isDeprecated: boolean;
}

/**
 * Upstream provider configuration
 */
export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  timeout: {
    connect: number;
    read: number;
  };
}

/**
 * Proxy request context
 */
export interface ProxyContext {
  requestId: string;
  model: ModelInfo;
  provider: ProviderConfig;
  isStreaming: boolean;
  startTime: number;
  ttfbTime?: number;
}

/**
 * Circuit breaker state
 */
export interface CircuitState {
  status: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number | null;
  nextRetry: number | null;
}

/**
 * OpenAI-compatible chat completion request
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
    content: string | null;
    name?: string;
    function_call?: object;
    tool_calls?: object[];
  }>;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  functions?: object[];
  function_call?: string | object;
  tools?: object[];
  tool_choice?: string | object;
  response_format?: { type: 'text' | 'json_object' };
  seed?: number;
}

/**
 * OpenAI-compatible chat completion response
 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      function_call?: object;
      tool_calls?: object[];
    };
    finish_reason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible models list response
 */
export interface ModelsListResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    permission?: object[];
    root?: string;
    parent?: string;
  }>;
}

/**
 * Request event for logging/metrics
 */
export interface RequestEventData {
  requestId: string;
  ownerType: string;
  ownerId: string;
  projectId?: string;
  apiKeyId: string;
  model: string;
  provider: string;
  endpoint: string;
  status: 'SUCCESS' | 'CLIENT_ERROR' | 'UPSTREAM_ERROR' | 'TIMEOUT' | 'RATE_LIMITED' | 'BILLING_BLOCKED';
  statusCode: number;
  errorType?: string;
  errorMessage?: string;
  latencyMs: number;
  ttfbMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  inputBytes: number;
  outputBytes: number;
  billingSource?: string;
  costCents?: number;
  isStreaming: boolean;
  streamChunks?: number;
  clientIp?: string;
  userAgent?: string;
}