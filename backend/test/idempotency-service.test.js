
const { test } = require("node:test");
const assert = require("node:assert/strict");

const Idempotency = require(
    "../src/models/Idempotency.model"
);

const {
    createFingerprint,
    getIdempotencyResult
} = require("../src/modules/Attendance/IdempotencyService");

const request = {
    key: "attendance-request-001",
    studentId: "student-123",
    sessionId: "session-456",
    token: "signed-qr-token",
    deviceId: "device-789",
    deviceSignature: "signed-device-proof",
    biometricAssertionId: "assertion-abc",
    latitude: 15.4589,
    longitude: 75.0078,
    accuracyMeters: 12,
    capturedAt: "2026-10-16T10:30:00.000Z"
};

function mockFindOne(t, record) {
    t.mock.method(
        Idempotency,
        "findOne",
        async ({ key }) => {
            assert.equal(key, request.key);
            return record;
        }
    );
}

test("returns the original response for an identical completed request", async (t) => {
    const responseBody = {
        success: true,
        message: "Attendance marked successfully",
        attendanceId: "attendance-123",
        alreadyMarked: false
    };

    mockFindOne(t, {
        key: request.key,
        fingerprint: createFingerprint(request),
        status: "COMPLETED",
        responseStatus: 201,
        responseBody
    });

    const result = await getIdempotencyResult(request);

    assert.equal(result.replayed, true);
    assert.equal(result.responseStatus, 201);
    assert.deepEqual(result.responseBody, responseBody);
});

test("rejects reuse of a key with a different biometric assertion", async (t) => {
    mockFindOne(t, {
        key: request.key,
        fingerprint: createFingerprint(request),
        status: "COMPLETED",
        responseStatus: 201,
        responseBody: { success: true }
    });

    await assert.rejects(
        getIdempotencyResult({
            ...request,
            biometricAssertionId: "different-assertion"
        }),
        (error) => {
            assert.equal(error.statusCode, 409);
            return true;
        }
    );
});

test("rejects reuse of a key with changed GPS coordinates", async (t) => {
    mockFindOne(t, {
        key: request.key,
        fingerprint: createFingerprint(request),
        status: "COMPLETED",
        responseStatus: 201,
        responseBody: { success: true }
    });

    await assert.rejects(
        getIdempotencyResult({
            ...request,
            latitude: 15.9
        }),
        (error) => {
            assert.equal(error.statusCode, 409);
            return true;
        }
    );
});

test("reports a request with an active processing lease as in progress", async (t) => {
    mockFindOne(t, {
        key: request.key,
        fingerprint: createFingerprint(request),
        status: "PROCESSING",
        ownerToken: "current-owner",
        leaseUntil: new Date(Date.now() + 60_000)
    });

    await assert.rejects(
        getIdempotencyResult(request),
        (error) => {
            assert.equal(error.statusCode, 409);
            assert.match(error.message, /already being processed/i);
            return true;
        }
    );
});

test("returns null when no idempotency record exists", async (t) => {
    mockFindOne(t, null);

    assert.equal(
        await getIdempotencyResult(request),
        null
    );
});

test("permits an expired processing lease to reach the existing claim logic", async (t) => {
    mockFindOne(t, {
        key: request.key,
        fingerprint: createFingerprint(request),
        status: "PROCESSING",
        ownerToken: "expired-owner",
        leaseUntil: new Date(Date.now() - 60_000)
    });

    assert.equal(
        await getIdempotencyResult(request),
        null
    );
});
