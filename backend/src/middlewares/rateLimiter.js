const {
    redisClient
} = require("../config/redis");

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]

local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

local time = redis.call("TIME")

local now =
    (tonumber(time[1]) * 1000)
    + math.floor(
        tonumber(time[2]) / 1000
    )

local values =
    redis.call(
        "HMGET",
        key,
        "tokens",
        "lastRefill"
    )

local tokens =
    tonumber(values[1])

local lastRefill =
    tonumber(values[2])

if tokens == nil then
    tokens = capacity
    lastRefill = now
end

local elapsed =
    math.max(
        0,
        now - lastRefill
    )

tokens =
    math.min(
        capacity,
        tokens +
        (elapsed / 1000) * refillRate
    )

local allowed = 0
local retryAfterMs = 0

if tokens >= cost then

    tokens =
        tokens - cost

    allowed = 1

else

    retryAfterMs =
        math.ceil(
            ((cost - tokens) /
            refillRate) * 1000
        )
end

redis.call(
    "HSET",
    key,
    "tokens",
    tokens,
    "lastRefill",
    now
)

redis.call(
    "PEXPIRE",
    key,
    ttlMs
)

return {
    allowed,
    math.floor(tokens),
    retryAfterMs
}
`;


const createRateLimiter = ({
    keyGenerator,
    capacity,
    refillPerSecond,
    cost = 1
}) => {

    if (
        capacity <= 0 ||
        refillPerSecond <= 0
    ) {
        throw new Error(
            "Invalid rate limiter configuration"
        );
    }

    const ttlMs =
        Math.ceil(
            (capacity /
                refillPerSecond) *
            2000
        );

    return async (
        req,
        res,
        next
    ) => {

        try {

            const identifier =
                keyGenerator(req);

            const key =
                `ratelimit:${identifier}`;

            const [
                allowed,
                remaining,
                retryAfterMs
            ] =
                await redisClient.eval(
                    TOKEN_BUCKET_SCRIPT,
                    {
                        keys: [key],

                        arguments: [
                            String(capacity),
                            String(refillPerSecond),
                            String(cost),
                            String(ttlMs)
                        ]
                    }
                );

            res.setHeader(
                "X-RateLimit-Limit",
                String(capacity)
            );

            res.setHeader(
                "X-RateLimit-Remaining",
                String(remaining)
            );

            if (Number(allowed) !== 1) {

                const retrySeconds =
                    Math.max(
                        1,
                        Math.ceil(
                            Number(
                                retryAfterMs
                            ) / 1000
                        )
                    );

                res.setHeader(
                    "Retry-After",
                    String(retrySeconds)
                );

                return res.status(429).json({
                    success: false,
                    error: {
                        code:
                            "RATE_LIMIT_EXCEEDED",
                        message:
                            "Too many requests. Please slow down."
                    },
                    requestId:
                        req.id
                });
            }

            next();

        } catch (error) {

            /*
             * Attendance verification is security-sensitive.
             *
             * If Redis is unavailable, fail closed
             * rather than silently removing the
             * distributed abuse protection.
             */

            console.error(
                "Rate limiter failed:",
                error
            );

            return res.status(503).json({
                success: false,
                error: {
                    code:
                        "RATE_LIMITER_UNAVAILABLE",
                    message:
                        "Attendance service temporarily unavailable"
                },
                requestId:
                    req.id
            });
        }
    };
};



module.exports = {
    createRateLimiter
};


