import { ModelPricing } from '../../modules/billing/interfaces/billing.interfaces';

/**
 * Test model pricing
 */
export const testModelPricing: ModelPricing = {
  modelId: 'gpt-4',
  priceCents: 5,
  inputPricePer1M: 3000,
  outputPricePer1M: 6000,
};

/**
 * Cheap model pricing
 */
export const cheapModelPricing: ModelPricing = {
  modelId: 'gpt-3.5-turbo',
  priceCents: 1,
  inputPricePer1M: 50,
  outputPricePer1M: 150,
};

/**
 * Test wallet data
 */
export const testWallet = {
  id: 'wallet_test_123',
  userId: 'user_test_123',
  organizationId: null,
  balanceCents: BigInt(10000), // $100.00
  totalTopupCents: BigInt(50000),
  totalSpentCents: BigInt(40000),
  currency: 'USD',
  isLocked: false,
  lockedReason: null,
  lockedAt: null,
  lastReconciledAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Locked wallet data
 */
export const lockedWallet = {
  ...testWallet,
  id: 'wallet_locked_123',
  isLocked: true,
  lockedReason: 'Payment dispute',
  lockedAt: new Date(),
};

/**
 * Empty wallet data
 */
export const emptyWallet = {
  ...testWallet,
  id: 'wallet_empty_123',
  balanceCents: BigInt(0),
};

/**
 * Billing Lua script success result (allowance)
 */
export const billingLuaAllowanceResult = [1, 'allowance', 0, 999, '10000'];

/**
 * Billing Lua script success result (wallet)
 */
export const billingLuaWalletResult = [1, 'wallet', 5, 0, '9995'];

/**
 * Billing Lua script idempotent hit result
 */
export const billingLuaIdempotentResult = [2, 'allowance', 0, 999, '10000'];

/**
 * Billing Lua script insufficient wallet result
 */
export const billingLuaInsufficientResult = [
  0,
  'insufficient_wallet',
  5,
  0,
  '3',
];

/**
 * Billing Lua script locked result
 */
export const billingLuaLockedResult = [0, 'locked', 0, 1000, '10000'];
