
const { test } = require("node:test");
const assert = require("node:assert/strict");

// BiometricService imports Redis during module initialization.
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const { redisClient } = require("../src/config/redis");
const BiometricEnrollment = require(
    "../src/models/BiometricEnrollment.model"
);
const provider = require(
    "../src/modules/Biometric/LocalBiometricProvider"
);
const biometricService = require(
    "../src/modules/Biometric/BiometricService"
);
const AppError = require("../src/utils/AppError");

const USER_ID = "student-123";
const SESSION_ID = "session-456";
const CHALLENGE_ID = "challenge-789";

function challengeKey() {
    return `biometric:challenge:${CHALLENGE_ID}`;
}

function validChallenge() {
    return JSON.stringify({
        userId: USER_ID,
        sessionId: SESSION_ID,
        challenge: "single-use-test-nonce"
    });
}

function validProviderResult() {
    return {
        verified: true,
        livenessPassed: true,
        faceMatchPassed: true,
        similarity: 0.97,
        verificationId: "provider-verification-123",
        providerUserId: USER_ID
    };
}

/**
 * Small in-memory Redis test double.
 *
 * eval() performs the compare-and-delete operation synchronously
 * before returning its promise, just as the Lua script is atomic
 * within Redis. It does not simulate network failures or TTL expiry.
 */
function mockRedis(t, initialEntries = {}) {
    const entries = new Map(Object.entries(initialEntries));

    t.mock.method(redisClient, "get", async (key) => {
        return entries.has(key) ? entries.get(key) : null;
    });

    t.mock.method(redisClient, "eval", async (_script, options) => {
        const key = options.keys[0];
        const expectedValue = options.arguments[0];

        if (entries.get(key) === expectedValue) {
            entries.delete(key);
            return 1;
        }

        return 0;
    });

    t.mock.method(redisClient, "set", async (key, value, options = {}) => {
        if (options.NX && entries.has(key)) {
            return null;
        }

        entries.set(key, value);
        return "OK";
    });

    t.mock.method(redisClient, "del", async (key) => {
        return entries.delete(key) ? 1 : 0;
    });

    return entries;
}

function verifyArgs(overrides = {}) {
    return {
        userId: USER_ID,
        sessionId: SESSION_ID,
        challengeId: CHALLENGE_ID,
        imageBuffer: Buffer.from("test-image"),
        mimeType: "image/jpeg",
        ...overrides
    };
}

function assertionArgs(assertionId) {
    return {
        assertionId,
        userId: USER_ID,
        sessionId: SESSION_ID
    };
}

test("two concurrent verifications consume one challenge only once", async (t) => {
    const entries = mockRedis(t, {
        [challengeKey()]: validChallenge()
    });

    let providerCalls = 0;

    t.mock.method(provider, "verify", async () => {
        providerCalls += 1;
        return validProviderResult();
    });

    t.mock.method(
        BiometricEnrollment,
        "updateOne",
        async () => ({
            acknowledged: true,
            matchedCount: 1,
            modifiedCount: 1
        })
    );

    const results = await Promise.allSettled([
        biometricService.verify(verifyArgs()),
        biometricService.verify(verifyArgs())
    ]);

    const fulfilled = results.filter(
        (result) => result.status === "fulfilled"
    );

    const rejected = results.filter(
        (result) => result.status === "rejected"
    );

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    assert.ok(
        [401, 409].includes(rejected[0].reason.statusCode),
        `Unexpected status: ${rejected[0].reason.statusCode}`
    );

    // The losing request must not reach the external provider.
    assert.equal(providerCalls, 1);

    assert.equal(entries.has(challengeKey()), false);

    const assertionKeys = [...entries.keys()].filter(
        (key) => key.startsWith("biometric:assertion:")
    );

    assert.equal(assertionKeys.length, 1);
});

test("a provider failure burns the challenge and retry requires a new one", async (t) => {
    const entries = mockRedis(t, {
        [challengeKey()]: validChallenge()
    });

    let providerCalls = 0;

    t.mock.method(provider, "verify", async () => {
        providerCalls += 1;
        throw new AppError("Biometric provider timeout", 504);
    });

    await assert.rejects(
        biometricService.verify(verifyArgs()),
        (error) => error.statusCode === 504
    );

    assert.equal(entries.has(challengeKey()), false);

    await assert.rejects(
        biometricService.verify(verifyArgs()),
        (error) => error.statusCode === 401
    );

    assert.equal(providerCalls, 1);
});

test("two concurrent attendance requests cannot consume one assertion twice", async (t) => {
    const assertionId = "assertion-once";
    const key = `biometric:assertion:${assertionId}`;

    const assertion = {
        userId: USER_ID,
        sessionId: SESSION_ID,
        verificationId: "provider-verification-456",
        providerUserId: USER_ID,
        livenessPassed: true,
        faceMatchPassed: true,
        similarity: 0.96
    };

    const entries = mockRedis(t, {
        [key]: JSON.stringify(assertion)
    });

    const results = await Promise.allSettled([
        biometricService.consumeAssertion(
            assertionArgs(assertionId)
        ),
        biometricService.consumeAssertion(
            assertionArgs(assertionId)
        )
    ]);

    const fulfilled = results.filter(
        (result) => result.status === "fulfilled"
    );

    const rejected = results.filter(
        (result) => result.status === "rejected"
    );

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    assert.ok(
        [401, 409].includes(rejected[0].reason.statusCode)
    );

    assert.equal(entries.has(key), false);
});

test("a different user cannot consume another student's challenge", async (t) => {
    const entries = mockRedis(t, {
        [challengeKey()]: validChallenge()
    });

    let providerCalls = 0;

    t.mock.method(provider, "verify", async () => {
        providerCalls += 1;
        return validProviderResult();
    });

    await assert.rejects(
        biometricService.verify(
            verifyArgs({ userId: "different-student" })
        ),
        (error) => error.statusCode === 403
    );

    assert.equal(entries.has(challengeKey()), true);
    assert.equal(providerCalls, 0);
});
