
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");

const testRedisUrl = process.env.TEST_REDIS_URL;

if (!testRedisUrl) {
    test(
        "real Redis rate limiter",
        {
            skip: "Set TEST_REDIS_URL to run the Redis integration test"
        },
        () => {}
    );
} else {
    process.env.REDIS_URL = testRedisUrl;

    const { redisClient } = require("../../src/config/redis");
    const { createRateLimiter } = require(
        "../../src/middlewares/rateLimiter"
    );

    test(
        "enforces the token bucket and fails closed when Redis errors",
        async (t) => {
            let server;

            const clientId = crypto.randomUUID();
            const redisKey = `ratelimit:integration:${clientId}`;

            t.after(async () => {
                if (server) {
                    await new Promise((resolve) => {
                        server.close(() => resolve());
                    });
                }

                if (redisClient.isReady) {
                    await redisClient.del(redisKey).catch(() => {});
                    await redisClient.quit().catch(() => {});
                }
            });

            if (!redisClient.isOpen) {
                await redisClient.connect();
            }

            const app = express();

            app.use((req, res, next) => {
                req.id = crypto.randomUUID();
                next();
            });

            const limiter = createRateLimiter({
                keyGenerator: (req) =>
                    `integration:${req.get("X-Test-Client")}`,
                capacity: 2,
                refillPerSecond: 0.01
            });

            app.get("/limited", limiter, (req, res) => {
                res.status(200).json({
                    success: true,
                    requestId: req.id
                });
            });

            server = app.listen(0, "127.0.0.1");

            await new Promise((resolve, reject) => {
                server.once("listening", resolve);
                server.once("error", reject);
            });

            const baseUrl =
                `http://127.0.0.1:${server.address().port}`;

            async function request(testClient = clientId) {
                const response = await fetch(
                    `${baseUrl}/limited`,
                    {
                        headers: {
                            "X-Test-Client": testClient
                        }
                    }
                );

                let body = {};

                try {
                    body = await response.json();
                } catch {
                    // The assertions below will report an unexpected body.
                }

                return { response, body };
            }

            // The first two requests consume the available tokens.
            const first = await request();
            const second = await request();

            assert.equal(first.response.status, 200);
            assert.equal(second.response.status, 200);

            // The third request must be rejected.
            const limited = await request();

            assert.equal(limited.response.status, 429);
            assert.equal(
                limited.body.error.code,
                "RATE_LIMIT_EXCEEDED"
            );
            assert.ok(
                Number(limited.response.headers.get("retry-after")) >= 1
            );
            assert.equal(
                limited.response.headers.get("x-ratelimit-limit"),
                "2"
            );
            assert.ok(limited.body.requestId);

            // Simulate a Redis command failure after the bucket is tested.
            t.mock.method(
                redisClient,
                "eval",
                async () => {
                    throw new Error("simulated Redis outage");
                }
            );

            // Suppress only the expected diagnostic in this isolated test.
            t.mock.method(console, "error", () => {});

            const outage = await request(
                `outage-${crypto.randomUUID()}`
            );

            assert.equal(outage.response.status, 503);
            assert.equal(
                outage.body.error.code,
                "RATE_LIMITER_UNAVAILABLE"
            );
            assert.ok(outage.body.requestId);
        }
    );
}
