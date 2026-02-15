import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { CircuitState } from './interfaces/gateway.interfaces';

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.threshold = this.config.get<number>('CIRCUIT_BREAKER_THRESHOLD', 50);
    this.resetMs = this.config.get<number>('CIRCUIT_BREAKER_RESET_MS', 30000);
  }

  /**
   * Get circuit breaker key for a provider
   */
  private getKey(provider: string): string {
    return `circuit:${provider}`;
  }

  /**
   * Check if circuit is open (requests should be blocked)
   */
  async isOpen(provider: string): Promise<boolean> {
    const state = await this.getState(provider);
    
    if (state.status === 'open') {
      // Check if we should transition to half-open
      if (state.nextRetry && Date.now() >= state.nextRetry) {
        await this.setHalfOpen(provider);
        return false; // Allow one request through
      }
      return true;
    }

    return false;
  }

  /**
   * Check circuit and throw if open
   */
  async checkCircuit(provider: string): Promise<void> {
    if (await this.isOpen(provider)) {
      this.logger.warn(`Circuit breaker OPEN for provider: ${provider}`);
      
      throw new ServiceUnavailableException({
        error: {
          message: `Service temporarily unavailable. Please try again later.`,
          type: 'service_unavailable_error',
          code: 'circuit_breaker_open',
        },
      });
    }
  }

  /**
   * Record a successful request
   */
  async recordSuccess(provider: string): Promise<void> {
    const state = await this.getState(provider);
    
    if (state.status === 'half-open') {
      // Success in half-open means we can close the circuit
      await this.close(provider);
      this.logger.log(`Circuit breaker CLOSED for provider: ${provider}`);
    }
  }

  /**
   * Record a failed request
   */
  async recordFailure(provider: string): Promise<void> {
    const key = this.getKey(provider);
    const state = await this.getState(provider);
    
    const newFailures = state.failures + 1;
    const now = Date.now();

    if (state.status === 'half-open') {
      // Failure in half-open means we should reopen
      await this.open(provider);
      this.logger.warn(`Circuit breaker re-OPENED for provider: ${provider}`);
      return;
    }

    if (newFailures >= this.threshold) {
      // Threshold exceeded, open the circuit
      await this.open(provider);
      this.logger.warn(`Circuit breaker OPENED for provider: ${provider} (${newFailures} failures)`);
    } else {
      // Update failure count
      const newState: CircuitState = {
        status: 'closed',
        failures: newFailures,
        lastFailure: now,
        nextRetry: null,
      };
      
      await this.redis.getClient().setex(
        key,
        Math.ceil(this.resetMs / 1000) * 2, // TTL longer than reset
        JSON.stringify(newState),
      );
    }
  }

  /**
   * Get current circuit state
   */
  async getState(provider: string): Promise<CircuitState> {
    const key = this.getKey(provider);
    const data = await this.redis.getClient().get(key);
    
    if (!data) {
      return {
        status: 'closed',
        failures: 0,
        lastFailure: null,
        nextRetry: null,
      };
    }

    try {
      return JSON.parse(data);
    } catch {
      return {
        status: 'closed',
        failures: 0,
        lastFailure: null,
        nextRetry: null,
      };
    }
  }

  /**
   * Open the circuit
   */
  private async open(provider: string): Promise<void> {
    const key = this.getKey(provider);
    const now = Date.now();
    
    const state: CircuitState = {
      status: 'open',
      failures: this.threshold,
      lastFailure: now,
      nextRetry: now + this.resetMs,
    };

    await this.redis.getClient().setex(
      key,
      Math.ceil(this.resetMs / 1000) * 2,
      JSON.stringify(state),
    );
  }

  /**
   * Set circuit to half-open
   */
  private async setHalfOpen(provider: string): Promise<void> {
    const key = this.getKey(provider);
    const state = await this.getState(provider);
    
    const newState: CircuitState = {
      status: 'half-open',
      failures: state.failures,
      lastFailure: state.lastFailure,
      nextRetry: null,
    };

    await this.redis.getClient().setex(
      key,
      Math.ceil(this.resetMs / 1000),
      JSON.stringify(newState),
    );
    
    this.logger.log(`Circuit breaker HALF-OPEN for provider: ${provider}`);
  }

  /**
   * Close the circuit
   */
  private async close(provider: string): Promise<void> {
    const key = this.getKey(provider);
    await this.redis.getClient().del(key);
  }

  /**
   * Force reset circuit (admin operation)
   */
  async forceReset(provider: string): Promise<void> {
    await this.close(provider);
    this.logger.log(`Circuit breaker FORCE RESET for provider: ${provider}`);
  }

  /**
   * Get all circuit states (for monitoring)
   */
  async getAllStates(): Promise<Record<string, CircuitState>> {
    const providers = ['openai', 'anthropic', 'google'];
    const states: Record<string, CircuitState> = {};

    for (const provider of providers) {
      states[provider] = await this.getState(provider);
    }

    return states;
  }
}