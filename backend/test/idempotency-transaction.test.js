
const { test } = require("node:test");
const assert = require("node:assert/strict");

const Idempotency = require(
    "../src/models/Idempotency.model"
);

const {
    completeIdempotency
} = require("../src/modules/Attendance/IdempotencyService");

test("completed idempotency response uses the attendance transaction", async (t) => {
    const dbSession = { marker: "expected-session" };
    let capturedOptions;

    t.mock.method(
        Idempotency,
        "updateOne",
        async (_filter, _update, options) => {
            capturedOptions = options;
            return { matchedCount: 1 };
        }
    );

    await completeIdempotency({
        key: "attendance-key-1",
        ownerToken: "owner-1",
        responseStatus: 201,
        responseBody: {
            success: true,
            attendanceId: "record-1"
        },
        dbSession
    });

    assert.equal(capturedOptions.session, dbSession);
});

test("does not silently complete a request after ownership is lost", async (t) => {
    t.mock.method(
        Idempotency,
        "updateOne",
        async () => ({ matchedCount: 0 })
    );

    await assert.rejects(
        completeIdempotency({
            key: "attendance-key-2",
            ownerToken: "stale-owner",
            responseStatus: 201,
            responseBody: { success: true }
        }),
        (error) => error.statusCode === 409
    );
});
