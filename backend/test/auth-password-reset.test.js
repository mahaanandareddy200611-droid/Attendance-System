
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const User = require("../src/models/Auth.model");
const authService = require("../src/modules/Auth/AuthService");

const TEST_EMAIL = "reset-user@example.com";
const TEST_OTP = "123456";

function otpHash(otp) {
    return crypto.createHash("sha256").update(otp).digest("hex");
}

function fakeUser(overrides = {}) {
    return {
        _id: "user-reset-123",
        email: TEST_EMAIL,
        passwordResetOtpHash: otpHash(TEST_OTP),
        passwordResetOtpExpires: new Date(Date.now() + 5 * 60 * 1000),
        passwordResetOtpAttempts: 0,
        passwordResetVerifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
        ...overrides
    };
}

function mockUserQuery(t, user) {
    t.mock.method(User, "findOne", () => ({
        select: async () => user
    }));
}

test("incorrect OTP increments attempts with an atomic conditional update", async (t) => {
    const user = fakeUser();
    let capturedFilter;
    let capturedUpdate;

    mockUserQuery(t, user);

    t.mock.method(User, "updateOne", async (filter, update) => {
        capturedFilter = filter;
        capturedUpdate = update;

        return { matchedCount: 1, modifiedCount: 1 };
    });

    await assert.rejects(
        authService.verifyResetOTP("999999", TEST_EMAIL),
        (error) => {
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /incorrect otp/i);
            return true;
        }
    );

    assert.equal(
        capturedFilter.passwordResetOtpAttempts.$lt,
        5
    );

    assert.equal(capturedUpdate.$inc.passwordResetOtpAttempts, 1);
});

test("correct OTP is consumed by one conditional database update", async (t) => {
    const user = fakeUser();
    let capturedFilter;
    let capturedUpdate;

    mockUserQuery(t, user);

    t.mock.method(User, "updateOne", async (filter, update) => {
        capturedFilter = filter;
        capturedUpdate = update;

        return { matchedCount: 1, modifiedCount: 1 };
    });

    const result = await authService.verifyResetOTP(
        TEST_OTP,
        TEST_EMAIL
    );

    assert.deepEqual(result, { verified: true });

    assert.equal(
        capturedFilter.passwordResetOtpHash,
        user.passwordResetOtpHash
    );

    assert.ok(capturedFilter.passwordResetOtpExpires.$gt instanceof Date);
    assert.equal(capturedUpdate.$set.passwordResetOtpHash, null);
    assert.equal(capturedUpdate.$set.passwordResetOtpExpires, null);
    assert.equal(capturedUpdate.$set.passwordResetOtpAttempts, 0);
    assert.ok(
        capturedUpdate.$set.passwordResetVerifiedUntil instanceof Date
    );
});

test("rejects OTP when the database reports it was already consumed", async (t) => {
    mockUserQuery(t, fakeUser());

    t.mock.method(User, "updateOne", async () => ({
        matchedCount: 0,
        modifiedCount: 0
    }));

    await assert.rejects(
        authService.verifyResetOTP(TEST_OTP, TEST_EMAIL),
        (error) => error.statusCode === 400
    );
});

test("password reset atomically consumes the verified window", async (t) => {
    const user = fakeUser();
    let capturedFilter;
    let capturedUpdate;

    mockUserQuery(t, user);

    t.mock.method(User, "updateOne", async (filter, update) => {
        capturedFilter = filter;
        capturedUpdate = update;

        return { matchedCount: 1, modifiedCount: 1 };
    });

    const result = await authService.password(
        "A-New-Strong-Password-123!",
        TEST_EMAIL
    );

    assert.deepEqual(result, { updated: true });

    assert.equal(capturedFilter._id, user._id);
    assert.ok(
        capturedFilter.passwordResetVerifiedUntil.$gt instanceof Date
    );

    assert.ok(
        typeof capturedUpdate.$set.password === "string"
    );

    assert.notEqual(
        capturedUpdate.$set.password,
        "A-New-Strong-Password-123!"
    );

    assert.equal(
        capturedUpdate.$set.passwordResetVerifiedUntil,
        null
    );

    // Password reset must invalidate previously issued access tokens.
    assert.equal(capturedUpdate.$inc.tokenVersion, 1);
});

test("rejects password reset if another request consumed the window first", async (t) => {
    mockUserQuery(t, fakeUser());

    t.mock.method(User, "updateOne", async () => ({
        matchedCount: 0,
        modifiedCount: 0
    }));

    await assert.rejects(
        authService.password(
            "A-New-Strong-Password-123!",
            TEST_EMAIL
        ),
        (error) => error.statusCode === 400
    );
});

test("unknown email receives the same forgot-password service result", async (t) => {
    t.mock.method(User, "findOne", async () => null);

    const result = await authService.forgotPassword(
        "unknown-account@example.com"
    );

    assert.deepEqual(result, { sent: true });
});
