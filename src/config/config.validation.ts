import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
    // Application
    NODE_ENV: Joi.string()
        .valid('development', 'production', 'test')
        .default('development'),
    PORT: Joi.number().default(3000),
    HOST: Joi.string().default('0.0.0.0'),
    CORS_ORIGINS: Joi.string().default('*'),
    LOG_LEVEL: Joi.string()
        .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
        .default('info'),

    // Database
    DATABASE_URL: Joi.string().required(),

    // Redis
    REDIS_URL: Joi.string().required(),

    // JWT
    JWT_SECRET: Joi.string().min(32).required(),
    JWT_EXPIRES_IN: Joi.string().default('7d'),

    // Stripe
    STRIPE_SECRET_KEY: Joi.string().required(),
    STRIPE_WEBHOOK_SECRET: Joi.string().required(),
    STRIPE_PUBLISHABLE_KEY: Joi.string().optional(),

    // Upstream Providers
    UPSTREAM_OPENAI_URL: Joi.string()
        .uri()
        .default('https://api.o7.team/openai'),
    UPSTREAM_ANTHROPIC_URL: Joi.string()
        .uri()
        .default('https://api.o7.team/anthropic'),
    UPSTREAM_OPENAI_COMPATIBLE_URL: Joi.string()
        .uri()
        .default('https://api.o7.team/openai-compatible'),
    UPSTREAM_API_KEY: Joi.string().required(),

    // Rate Limiting Defaults
    DEFAULT_LIMIT_PER_MINUTE: Joi.number().default(20),
    DEFAULT_LIMIT_PER_HOUR: Joi.number().default(100),
    DEFAULT_LIMIT_PER_DAY: Joi.number().default(500),
    DEFAULT_MAX_CONCURRENT: Joi.number().default(5),

    // Global Limits
    GLOBAL_MAX_CONCURRENT: Joi.number().default(1000),
    GLOBAL_MAX_RPS: Joi.number().default(500),

    // Timeouts
    UPSTREAM_CONNECT_TIMEOUT_MS: Joi.number().default(5000),
    UPSTREAM_READ_TIMEOUT_MS: Joi.number().default(120000),
    STREAM_MAX_DURATION_MS: Joi.number().default(300000),

    // Request Limits
    MAX_BODY_BYTES: Joi.number().default(10485760), // 10MB
    MAX_INPUT_TOKENS: Joi.number().default(128000),
    MAX_OUTPUT_TOKENS: Joi.number().default(16000),

    // Circuit Breaker
    CIRCUIT_BREAKER_THRESHOLD: Joi.number().default(50),
    CIRCUIT_BREAKER_RESET_MS: Joi.number().default(30000),
});

export type ConfigValidation = {
    NODE_ENV: 'development' | 'production' | 'test';
    PORT: number;
    HOST: string;
    CORS_ORIGINS: string;
    LOG_LEVEL: string;
    DATABASE_URL: string;
    REDIS_URL: string;
    JWT_SECRET: string;
    JWT_EXPIRES_IN: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
    STRIPE_PUBLISHABLE_KEY?: string;
    UPSTREAM_OPENAI_URL: string;
    UPSTREAM_ANTHROPIC_URL: string;
    UPSTREAM_OPENAI_COMPATIBLE_URL: string;
    UPSTREAM_API_KEY: string;
    DEFAULT_LIMIT_PER_MINUTE: number;
    DEFAULT_LIMIT_PER_HOUR: number;
    DEFAULT_LIMIT_PER_DAY: number;
    DEFAULT_MAX_CONCURRENT: number;
    GLOBAL_MAX_CONCURRENT: number;
    GLOBAL_MAX_RPS: number;
    UPSTREAM_CONNECT_TIMEOUT_MS: number;
    UPSTREAM_READ_TIMEOUT_MS: number;
    STREAM_MAX_DURATION_MS: number;
    MAX_BODY_BYTES: number;
    MAX_INPUT_TOKENS: number;
    MAX_OUTPUT_TOKENS: number;
    CIRCUIT_BREAKER_THRESHOLD: number;
    CIRCUIT_BREAKER_RESET_MS: number;
};