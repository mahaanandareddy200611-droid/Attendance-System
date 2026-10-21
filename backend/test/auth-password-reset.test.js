"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const User = require("../src/models/Auth.model");
const authService = require("../src/modules/Auth/AuthService");

const TEST_EMAIL = "reset-user@example.com";
const TEST_OTP = "123456";
const RESET_TOKEN = "A".repeat(43);

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
    ...overrides,
  };
}

function mockUserQuery(t, user) {
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
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

  await assert.rejects(authService.verifyResetOTP("999999", TEST_EMAIL), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /incorrect otp/i);
    return true;
  });
  assert.equal(capturedFilter.passwordResetOtpAttempts.$lt, 5);
  assert.equal(capturedUpdate.$inc.passwordResetOtpAttempts, 1);
});

test("correct OTP is consumed atomically and returns a secret whose hash alone is stored", async (t) => {
  const user = fakeUser();
  let capturedFilter;
  let capturedUpdate;
  mockUserQuery(t, user);
  t.mock.method(crypto, "randomBytes", (length) => {
    assert.equal(length, 32);
    return Buffer.alloc(32, 1);
  });
  t.mock.method(User, "updateOne", async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  const result = await authService.verifyResetOTP(TEST_OTP, TEST_EMAIL);
  assert.deepEqual(Object.keys(result).sort(), ["resetToken", "verified"]);
  assert.equal(result.verified, true);
  assert.match(result.resetToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(capturedFilter.passwordResetOtpHash, user.passwordResetOtpHash);
  assert.ok(capturedFilter.passwordResetOtpExpires.$gt instanceof Date);
  assert.equal(capturedUpdate.$set.passwordResetOtpHash, null);
  assert.equal(capturedUpdate.$set.passwordResetOtpExpires, null);
  assert.equal(capturedUpdate.$set.passwordResetOtpAttempts, 0);
  assert.equal(capturedUpdate.$set.passwordResetVerifiedUntil, null);
  assert.equal(capturedUpdate.$set.passwordResetTokenHash, otpHash(result.resetToken));
  assert.ok(capturedUpdate.$set.passwordResetTokenExpires instanceof Date);
});

test("rejects OTP when the database reports it was already consumed", async (t) => {
  mockUserQuery(t, fakeUser());
  t.mock.method(User, "updateOne", async () => ({ matchedCount: 0, modifiedCount: 0 }));
  await assert.rejects(authService.verifyResetOTP(TEST_OTP, TEST_EMAIL), (error) => error.statusCode === 400);
});

test("password reset atomically consumes the reset token and revokes existing JWTs", async (t) => {
  let capturedFilter;
  let capturedUpdate;
  t.mock.method(User, "updateOne", async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  const result = await authService.password("A-New-Strong-Password-123!", TEST_EMAIL, RESET_TOKEN);
  assert.deepEqual(result, { updated: true });
  assert.equal(capturedFilter.email, TEST_EMAIL);
  assert.equal(capturedFilter.passwordResetTokenHash, otpHash(RESET_TOKEN));
  assert.ok(capturedFilter.passwordResetTokenExpires.$gt instanceof Date);
  assert.equal(typeof capturedUpdate.$set.password, "string");
  assert.notEqual(capturedUpdate.$set.password, "A-New-Strong-Password-123!");
  assert.equal(capturedUpdate.$set.passwordResetTokenHash, null);
  assert.equal(capturedUpdate.$set.passwordResetTokenExpires, null);
  assert.equal(capturedUpdate.$set.passwordResetVerifiedUntil, null);
  assert.equal(capturedUpdate.$inc.tokenVersion, 1);
});

test("password reset requires the high-entropy token rather than just an account email", async (t) => {
  let updateCalls = 0;
  t.mock.method(User, "updateOne", async () => {
    updateCalls += 1;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  await assert.rejects(authService.password("A-New-Strong-Password-123!", TEST_EMAIL), (error) => error.statusCode === 400);
  await assert.rejects(authService.password("A-New-Strong-Password-123!", TEST_EMAIL, "short"), (error) => error.statusCode === 400);
  assert.equal(updateCalls, 0);
});

test("rejects password reset if another request consumed the token first", async (t) => {
  t.mock.method(User, "updateOne", async () => ({ matchedCount: 0, modifiedCount: 0 }));
  await assert.rejects(
    authService.password("A-New-Strong-Password-123!", TEST_EMAIL, RESET_TOKEN),
    (error) => error.statusCode === 400,
  );
});

test("unknown email receives the same forgot-password service result", async (t) => {
  t.mock.method(User, "findOne", async () => null);
  assert.deepEqual(await authService.forgotPassword("unknown-account@example.com"), { sent: true });
});
