-- Concurrency Control Lua Script
-- Atomic acquire/release of concurrency slots
--
-- For ACQUIRE:
-- KEYS[1] = concurrency counter key
-- ARGV[1] = max concurrent requests
-- ARGV[2] = request_id (for tracking)
-- ARGV[3] = TTL in seconds (auto-release safety)
-- ARGV[4] = operation: "acquire" or "release"
--
-- Returns for acquire: {allowed, current_count, max_count}
--   allowed: 1 if slot acquired, 0 if at max
--
-- For RELEASE:
-- Returns: {1, new_count, max_count}

local counter_key = KEYS[1]
local max_concurrent = tonumber(ARGV[1])
local request_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local operation = ARGV[4]

if operation == "acquire" then
    -- Get current count
    local current = tonumber(redis.call('GET', counter_key) or '0')
    
    -- Check if we can acquire
    if current >= max_concurrent then
        return {0, current, max_concurrent}
    end
    
    -- Increment counter
    local new_count = redis.call('INCR', counter_key)
    
    -- Set TTL if this is first increment (safety net)
    if new_count == 1 then
        redis.call('EXPIRE', counter_key, ttl)
    end
    
    -- Also track individual request for debugging (optional)
    local tracking_key = counter_key .. ':requests'
    redis.call('HSET', tracking_key, request_id, tostring(os.time()))
    redis.call('EXPIRE', tracking_key, ttl)
    
    return {1, new_count, max_concurrent}
    
elseif operation == "release" then
    -- Decrement counter (but not below 0)
    local current = tonumber(redis.call('GET', counter_key) or '0')
    
    if current > 0 then
        local new_count = redis.call('DECR', counter_key)
        
        -- Remove from tracking
        local tracking_key = counter_key .. ':requests'
        redis.call('HDEL', tracking_key, request_id)
        
        return {1, new_count, max_concurrent}
    end
    
    return {1, 0, max_concurrent}
else
    return {0, 0, 0}
end