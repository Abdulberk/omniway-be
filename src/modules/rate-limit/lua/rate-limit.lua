-- Rate Limit Lua Script
-- Atomic check and increment for minute/hour/day limits
-- 
-- KEYS[1] = minute counter key
-- KEYS[2] = hour counter key  
-- KEYS[3] = day counter key
--
-- ARGV[1] = minute limit
-- ARGV[2] = hour limit
-- ARGV[3] = day limit
-- ARGV[4] = current timestamp (Unix seconds)
--
-- Returns: {allowed, minute_remaining, hour_remaining, day_remaining, reset_at}
--   allowed: 1 if request is allowed, 0 if rate limited
--   *_remaining: remaining requests in each window
--   reset_at: when the earliest limit resets (Unix timestamp)

local minute_key = KEYS[1]
local hour_key = KEYS[2]
local day_key = KEYS[3]

local minute_limit = tonumber(ARGV[1])
local hour_limit = tonumber(ARGV[2])
local day_limit = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Calculate window boundaries
local minute_start = math.floor(now / 60) * 60
local hour_start = math.floor(now / 3600) * 3600
local day_start = math.floor(now / 86400) * 86400

-- Calculate TTLs (expire at end of window + 1 second buffer)
local minute_ttl = 60 - (now - minute_start) + 1
local hour_ttl = 3600 - (now - hour_start) + 1
local day_ttl = 86400 - (now - day_start) + 1

-- Get current counts
local minute_count = tonumber(redis.call('GET', minute_key) or '0')
local hour_count = tonumber(redis.call('GET', hour_key) or '0')
local day_count = tonumber(redis.call('GET', day_key) or '0')

-- Check if any limit would be exceeded
if minute_count >= minute_limit then
    local reset_at = minute_start + 60
    return {0, 0, hour_limit - hour_count, day_limit - day_count, reset_at, 'minute'}
end

if hour_count >= hour_limit then
    local reset_at = hour_start + 3600
    return {0, minute_limit - minute_count, 0, day_limit - day_count, reset_at, 'hour'}
end

if day_count >= day_limit then
    local reset_at = day_start + 86400
    return {0, minute_limit - minute_count, hour_limit - hour_count, 0, reset_at, 'day'}
end

-- All limits OK, increment counters
local new_minute = redis.call('INCR', minute_key)
if new_minute == 1 then
    redis.call('EXPIRE', minute_key, minute_ttl)
end

local new_hour = redis.call('INCR', hour_key)
if new_hour == 1 then
    redis.call('EXPIRE', hour_key, hour_ttl)
end

local new_day = redis.call('INCR', day_key)
if new_day == 1 then
    redis.call('EXPIRE', day_key, day_ttl)
end

-- Calculate remaining
local minute_remaining = minute_limit - new_minute
local hour_remaining = hour_limit - new_hour
local day_remaining = day_limit - new_day

-- Find earliest reset time
local reset_at = minute_start + 60
if hour_remaining < minute_remaining then
    reset_at = hour_start + 3600
end
if day_remaining < hour_remaining and day_remaining < minute_remaining then
    reset_at = day_start + 86400
end

return {1, minute_remaining, hour_remaining, day_remaining, reset_at, 'none'}