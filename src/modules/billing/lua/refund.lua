-- Refund Lua Script with Daily Cap + Idempotency
-- ================================================
-- Atomic refund operation that:
-- 1. Checks idempotency (prevent double refunds for same requestId)
-- 2. Checks daily refund cap per owner
-- 3. Increments refund count
-- 4. Adds refund amount to wallet balance

-- Keys:
-- KEYS[1] = refund idempotency key (billing:refund:{requestId})
-- KEYS[2] = daily refund count key (billing:{ownerType}:{ownerId}:refunds:{date})
-- KEYS[3] = wallet balance key (billing:{ownerType}:{ownerId}:wallet)

-- Args:
-- ARGV[1] = refund amount (in minor units, e.g., cents)
-- ARGV[2] = daily refund cap (e.g., 10)
-- ARGV[3] = TTL for refund count key (seconds until end of day)
-- ARGV[4] = idempotency TTL (e.g., 604800 = 1 week)
-- ARGV[5] = requestId (for logging in idempotency key)

-- Returns:
-- -1 = already refunded (idempotency hit)
-- -2 = daily cap exceeded
-- positive number = new wallet balance after refund (in minor units)

local idempotencyKey = KEYS[1]
local refundCountKey = KEYS[2]
local walletKey = KEYS[3]

local refundAmount = tonumber(ARGV[1])
local dailyCap = tonumber(ARGV[2])
local countTTL = tonumber(ARGV[3])
local idempotencyTTL = tonumber(ARGV[4])
local requestId = ARGV[5]

-- 1. Check idempotency - if this request was already refunded, return early
local alreadyRefunded = redis.call('EXISTS', idempotencyKey)
if alreadyRefunded == 1 then
    return -1
end

-- 2. Check daily refund count
local currentCount = redis.call('GET', refundCountKey)
if currentCount ~= false then
    currentCount = tonumber(currentCount)
    if currentCount >= dailyCap then
        return -2
    end
end

-- 3. Mark as refunded (idempotency) - set before doing the refund
-- This prevents race conditions where two refund attempts happen simultaneously
redis.call('SET', idempotencyKey, requestId, 'EX', idempotencyTTL)

-- 4. Increment daily refund count
local newCount = redis.call('INCR', refundCountKey)
if newCount == 1 then
    -- First refund of the day, set TTL
    redis.call('EXPIRE', refundCountKey, countTTL)
end

-- 5. Add refund amount to wallet balance
-- INCRBY handles the case where wallet key doesn't exist (starts at 0)
local newBalance = redis.call('INCRBY', walletKey, refundAmount)

return newBalance