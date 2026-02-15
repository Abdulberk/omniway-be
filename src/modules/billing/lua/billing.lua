-- Billing Lua Script (v1.7.7)
-- Atomic allowance-or-wallet billing decision
-- 
-- KEYS[1] = allow:used:{ownerType}:{ownerId}:{YYYYMMDD} (allowance counter)
-- KEYS[2] = wallet:{ownerType}:{ownerId}:balance_cents (wallet balance)
-- KEYS[3] = idem:billing:{ownerType}:{ownerId}:{requestId} (idempotency)
-- KEYS[4] = wallet:{ownerType}:{ownerId}:locked (wallet lock flag)
--
-- ARGV[1] = daily_allowance_requests (plan limit)
-- ARGV[2] = price_cents (model price, MUST be <= 2^53-1)
-- ARGV[3] = request_id (for audit)
-- ARGV[4] = idem_ttl_sec (86400)
-- ARGV[5] = day_ttl_sec (seconds until UTC midnight)
--
-- Returns: {code, source, charged_cents, allowance_remaining, wallet_balance_str}
--   code: 0 = insufficient, 1 = success, 2 = idempotent hit
--   source: 'allowance' | 'wallet' | 'insufficient_wallet' | 'locked'
--   charged_cents: amount charged (0 for allowance)
--   allowance_remaining: remaining daily allowance
--   wallet_balance_str: current wallet balance as string (BigInt safe)

local used_key = KEYS[1]
local wallet_key = KEYS[2]
local idem_key = KEYS[3]
local lock_key = KEYS[4]

local daily_allowance = tonumber(ARGV[1]) or 0
local price_cents = tonumber(ARGV[2]) or 0  -- Safe: price_cents is always small
local idem_ttl = tonumber(ARGV[4]) or 86400
local day_ttl = tonumber(ARGV[5]) or 86400

-- Check wallet lock first (disputes/chargebacks)
local is_locked = redis.call('GET', lock_key)
if is_locked == '1' then
    local balance_str = redis.call('GET', wallet_key) or '0'
    return {0, 'locked', 0, daily_allowance, balance_str}
end

-- Check idempotency - return cached result if already processed
local cached = redis.call('GET', idem_key)
if cached then
    -- Parse cached result: "source:charged:remaining:balance"
    local parts = {}
    for part in string.gmatch(cached, "[^:]+") do 
        table.insert(parts, part) 
    end
    -- Return code 2 for idempotent hit
    return {2, parts[1], tonumber(parts[2] or '0'), tonumber(parts[3] or '0'), parts[4] or '0'}
end

-- Get current allowance usage
local used = tonumber(redis.call('GET', used_key) or '0')
local balance_str = redis.call('GET', wallet_key) or '0'

-- Try allowance first (if available and not exhausted)
if daily_allowance > 0 and used < daily_allowance then
    -- Increment allowance counter
    local new_used = redis.call('INCR', used_key)
    
    -- Set TTL if this is the first increment
    if new_used == 1 then 
        redis.call('EXPIRE', used_key, day_ttl) 
    end

    local remaining = daily_allowance - new_used
    
    -- Cache the billing result for idempotency
    redis.call('SETEX', idem_key, idem_ttl, 'allowance:0:' .. remaining .. ':' .. balance_str)
    
    return {1, 'allowance', 0, remaining, balance_str}
end

-- Allowance exhausted or not available - try wallet
if price_cents <= 0 then
    -- No wallet charge needed (free request or misconfiguration)
    local remaining = math.max(0, daily_allowance - used)
    redis.call('SETEX', idem_key, idem_ttl, 'allowance:0:' .. remaining .. ':' .. balance_str)
    return {1, 'allowance', 0, remaining, balance_str}
end

-- Check wallet balance (comparison is safe for values < 2^53)
local balance_num = tonumber(balance_str) or 0

if balance_num < price_cents then
    -- Insufficient wallet balance
    local remaining = math.max(0, daily_allowance - used)
    return {0, 'insufficient_wallet', price_cents, remaining, balance_str}
end

-- Deduct from wallet using INCRBY (atomic, BigInt safe in Redis)
local new_balance = redis.call('INCRBY', wallet_key, -price_cents)
local new_balance_str = tostring(new_balance)

local remaining = math.max(0, daily_allowance - used)

-- Cache the billing result for idempotency
redis.call('SETEX', idem_key, idem_ttl, 'wallet:' .. price_cents .. ':' .. remaining .. ':' .. new_balance_str)

return {1, 'wallet', price_cents, remaining, new_balance_str}