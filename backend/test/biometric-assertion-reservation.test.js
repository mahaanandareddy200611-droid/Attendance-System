process.env.REDIS_URL ||= "redis://127.0.0.1:6379";
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { redisClient } = require("../src/config/redis");

const {
    reserveAssertion,
    validateAssertion,
    releaseAssertionReservation,
    finalizeAssertionReservation
} = require("../src/modules/Biometric/BiometricService");

const USER_ID = "student-123";
const SESSION_ID = "session-456";
const ASSERTION_ID = "assertion-789";
const KEY = `biometric:assertion:${ASSERTION_ID}`;

function validAssertion() {
    return {
        userId: USER_ID,
        sessionId: SESSION_ID,
        verificationId: "provider-verification-1",
        providerUserId: USER_ID,
        livenessPassed: true,
        faceMatchPassed: true,
        activeLivenessPassed: true,
        livenessMode: "ACTIVE_SEQUENCE_V1",
        similarity: 0.96
    };
}

function mockRedis(t, initial = {}) {
    const entries = new Map(
        Object.entries(initial).map(([key, value]) => [
            key,
            JSON.stringify(value)
        ])
    );

    t.mock.method(redisClient, "get", async (key) => {
        return entries.get(key) ?? null;
    });

    t.mock.method(redisClient, "eval", async (script, options) => {
        const [key] = options.keys;
        const args = options.arguments;
        const current = entries.get(key);

        if (script.includes("assertion.reservationId = ARGV[2]")) {
            if (!current || current !== args[0]) {
                return 0;
            }

            const assertion = JSON.parse(current);

            if (assertion.reservationId) {
                return 0;
            }

            entries.set(
                key,
                JSON.stringify({
                    ...assertion,
                    reservationId: args[1],
                    state: "RESERVED"
                })
            );

            return 1;
        }

        if (script.includes("assertion.reservationId = nil")) {
            if (!current) {
                return 0;
            }

            const assertion = JSON.parse(current);

            if (
                assertion.reservationId !== args[0] ||
                assertion.state !== "RESERVED"
            ) {
                return 0;
            }

            delete assertion.reservationId;
            delete assertion.state;

            entries.set(key, JSON.stringify(assertion));
            return 1;
        }

        if (script.includes('return redis.call("DEL", KEYS[1])')) {
            if (!current) {
                return 0;
            }

            const assertion = JSON.parse(current);

            if (
                assertion.reservationId !== args[0] ||
                assertion.state !== "RESERVED"
            ) {
                return 0;
            }

            entries.delete(key);
            return 1;
        }

        throw new Error("Unexpected Redis script in test");
    });

    return entries;
}

function reserve(reservationId, overrides = {}) {
    return reserveAssertion({
        assertionId: ASSERTION_ID,
        userId: USER_ID,
        sessionId: SESSION_ID,
        reservationId,
        ...overrides
    });
}

test("rejects an assertion produced without the active three-frame liveness sequence", async (t) => {
    mockRedis(t, {
        [KEY]: {
            ...validAssertion(),
            activeLivenessPassed: false,
            livenessMode: undefined
        }
    });

    await assert.rejects(
        reserve("attendance-key-1"),
        (error) => error.statusCode === 401 && /active face\/liveness/i.test(error.message)
    );
});

test("validateAssertion rejects legacy single-image biometric assertions", async (t) => {
    mockRedis(t, {
        [KEY]: {
            ...validAssertion(),
            activeLivenessPassed: undefined,
            livenessMode: undefined
        }
    });

    await assert.rejects(
        validateAssertion({
            assertionId: ASSERTION_ID,
            userId: USER_ID,
            sessionId: SESSION_ID
        }),
        (error) => error.statusCode === 401 && /active face\/liveness/i.test(error.message)
    );
});

test("reserves an assertion for the correct student and session", async (t) => {
    const entries = mockRedis(t, {
        [KEY]: validAssertion()
    });

    const result = await reserve("attendance-key-1");

    assert.equal(result.state, "RESERVED");
    assert.equal(result.reservationId, "attendance-key-1");

    const stored = JSON.parse(entries.get(KEY));

    assert.equal(stored.state, "RESERVED");
    assert.equal(stored.reservationId, "attendance-key-1");
});

test("only one of two competing operations can reserve the assertion", async (t) => {
    mockRedis(t, {
        [KEY]: validAssertion()
    });

    const results = await Promise.allSettled([
        reserve("attendance-key-A"),
        reserve("attendance-key-B")
    ]);

    assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1
    );

    assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1
    );
});

test("a different student cannot reserve the assertion", async (t) => {
    const entries = mockRedis(t, {
        [KEY]: validAssertion()
    });

    await assert.rejects(
        reserve("attendance-key-1", {
            userId: "different-student"
        }),
        (error) => error.statusCode === 403
    );

    assert.equal(
        JSON.parse(entries.get(KEY)).reservationId,
        undefined
    );
});

test("the same operation can recover its existing reservation", async (t) => {
    mockRedis(t, {
        [KEY]: {
            ...validAssertion(),
            reservationId: "attendance-key-1",
            state: "RESERVED"
        }
    });

    const result = await reserve("attendance-key-1");

    assert.equal(result.reservationId, "attendance-key-1");
    assert.equal(result.state, "RESERVED");
});

test("release restores an assertion after a failed transaction", async (t) => {
    const entries = mockRedis(t, {
        [KEY]: validAssertion()
    });

    await reserve("attendance-key-1");

    const released = await releaseAssertionReservation({
        assertionId: ASSERTION_ID,
        reservationId: "attendance-key-1"
    });

    assert.equal(released, true);

    const stored = JSON.parse(entries.get(KEY));

    assert.equal(stored.reservationId, undefined);
    assert.equal(stored.state, undefined);

    // A later operation can now reserve it.
    const second = await reserve("attendance-key-2");

    assert.equal(second.reservationId, "attendance-key-2");
});

test("a different operation cannot release somebody else's reservation", async (t) => {
    const entries = mockRedis(t, {
        [KEY]: {
            ...validAssertion(),
            reservationId: "owner-key",
            state: "RESERVED"
        }
    });

    const released = await releaseAssertionReservation({
        assertionId: ASSERTION_ID,
        reservationId: "attacker-key"
    });

    assert.equal(released, false);

    assert.equal(
        JSON.parse(entries.get(KEY)).reservationId,
        "owner-key"
    );
});

test("finalization consumes the assertion for its reservation owner", async (t) => {
    const entries = mockRedis(t, {
        [KEY]: validAssertion()
    });

    await reserve("attendance-key-1");

    const finalized = await finalizeAssertionReservation({
        assertionId: ASSERTION_ID,
        reservationId: "attendance-key-1"
    });

    assert.equal(finalized, true);
    assert.equal(entries.has(KEY), false);

    await assert.rejects(
        reserve("attendance-key-2"),
        (error) => error.statusCode === 401
    );
});
