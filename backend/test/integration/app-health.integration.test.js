
const { test } = require("node:test");
const assert = require("node:assert/strict");

const mongoUrl = process.env.TEST_MONGO_URL;
const redisUrl = process.env.TEST_REDIS_URL;

if (!mongoUrl || !redisUrl) {
    test(
        "Express application health and security integration",
        {
            skip: "Set TEST_MONGO_URL and TEST_REDIS_URL to run the HTTP integration test"
        },
        () => {}
    );
} else {
    const databaseName = decodeURIComponent(
        new URL(mongoUrl).pathname
            .replace(/^\/+/, "")
            .split("/")[0]
    );

    if (databaseName !== "attendance_test") {
        throw new Error(
            "Safety check failed: test URL must use attendance_test"
        );
    }

    // Configure before importing app.js and its Redis client.
    process.env.REDIS_URL = redisUrl;

    const mongoose = require("mongoose");
    const { redisClient } = require("../../src/config/redis");
    const app = require("../../src/app");

    test(
        "health, readiness, request IDs, security headers, 404 and CORS work over HTTP",
        async (t) => {
            let server;
            let connectedMongo = false;
            let connectedRedis = false;

            t.after(async () => {
                if (server) {
                    await new Promise((resolve, reject) => {
                        server.close((error) => {
                            if (error) reject(error);
                            else resolve();
                        });
                    });
                }

                if (connectedRedis && redisClient.isOpen) {
                    await redisClient.quit();
                }

                if (connectedMongo) {
                    await mongoose.disconnect();
                }
            });

            await mongoose.connect(mongoUrl, {
                serverSelectionTimeoutMS: 5000
            });
            connectedMongo = true;

            if (!redisClient.isOpen) {
                await redisClient.connect();
            }
            connectedRedis = true;

            server = app.listen(0, "127.0.0.1");

            await new Promise((resolve, reject) => {
                server.once("listening", resolve);
                server.once("error", reject);
            });

            const address = server.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;

            // 1. Liveness: the process can serve requests.
            const liveResponse = await fetch(
                `${baseUrl}/api/v1/livez`
            );

            assert.equal(liveResponse.status, 200);

            const liveBody = await liveResponse.json();

            assert.equal(liveBody.success, true);
            assert.equal(liveBody.status, "alive");
            assert.ok(liveBody.requestId);

            // 2. Health route includes a request ID and security headers.
            const healthResponse = await fetch(
                `${baseUrl}/api/v1/health`,
                {
                    headers: {
                        "X-Request-ID": "integration-health-001"
                    }
                }
            );

            assert.equal(healthResponse.status, 200);
            assert.equal(
                healthResponse.headers.get("x-request-id"),
                "integration-health-001"
            );
            assert.equal(
                healthResponse.headers.get("x-powered-by"),
                null
            );

            const healthBody = await healthResponse.json();

            assert.equal(healthBody.success, true);
            assert.equal(healthBody.status, "healthy");

            // 3. Readiness must reflect both real dependencies.
            const readyResponse = await fetch(
                `${baseUrl}/api/v1/readyz`
            );

            assert.equal(readyResponse.status, 200);

            const readyBody = await readyResponse.json();

            assert.equal(readyBody.success, true);
            assert.equal(readyBody.dependencies.mongodb, true);
            assert.equal(readyBody.dependencies.redis, true);

            // 4. Unknown routes must return a structured 404.
            const missingResponse = await fetch(
                `${baseUrl}/api/v1/route-that-does-not-exist`
            );

            assert.equal(missingResponse.status, 404);

            const missingBody = await missingResponse.json();

            assert.equal(missingBody.success, false);
            assert.equal(
                missingBody.error.code,
                "ROUTE_NOT_FOUND"
            );
            assert.ok(missingBody.requestId);

            // 5. An unapproved browser origin must be rejected.
            
            // An unapproved browser origin must be rejected and traceable.
            const corsResponse = await fetch(
                `${baseUrl}/api/v1/health`,
                {
                    headers: {
                        Origin: "https://unapproved.example"
                    }
                }
            );

            assert.equal(corsResponse.status, 403);

            const corsBody = await corsResponse.json();

            assert.equal(corsBody.success, false);
            assert.ok(corsBody.requestId);
            assert.equal(
                corsBody.requestId,
                corsResponse.headers.get("x-request-id")
            );

            assert.equal(
                corsResponse.headers.get("access-control-allow-origin"),
                null
            );

            // Even JSON parsing failures must have a request ID.
            const malformedJsonResponse = await fetch(
                `${baseUrl}/api/v1/auth/login`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: "{"
                }
            );

            assert.equal(malformedJsonResponse.status, 400);
            assert.ok(
                malformedJsonResponse.headers.get("x-request-id")
            );

            const malformedJsonBody =
                await malformedJsonResponse.json();

            assert.equal(malformedJsonBody.success, false);
            assert.equal(
                malformedJsonBody.requestId,
                malformedJsonResponse.headers.get("x-request-id")
            );


            assert.equal(corsResponse.status, 403);
        }
    );
}
