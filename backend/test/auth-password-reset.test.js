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
    assert.match(error.message, /invalid or expired otp/i);
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


test("exhausted OTP responses are generic and do not disclose recovery state", async (t) => {
  const user = fakeUser({ passwordResetOtpAttempts: 5 });
  mockUserQuery(t, user);
  let updates = 0;
  t.mock.method(User, "updateOne", async () => {
    updates += 1;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  await assert.rejects(
    authService.verifyResetOTP(TEST_OTP, TEST_EMAIL),
    (error) => error.statusCode === 400 && error.message === "Invalid or expired OTP",
  );
  assert.equal(updates, 0, "exhausted OTP counters must not be incremented again");
});


test("forgot-password normalizes email and clears an OTP when email delivery is not configured", async (t) => {
  const user = fakeUser({
    _id: "user-mail-failure",
    passwordResetOtpHash: null,
    passwordResetOtpExpires: null,
    passwordResetOtpAttempts: 0,
    save: async () => {},
  });
  let lookupFilter;
  let cleanupFilter;
  let cleanupUpdate;
  t.mock.method(User, "findOne", async (filter) => {
    lookupFilter = filter;
    return user;
  });
  t.mock.method(User, "updateOne", async (filter, update) => {
    cleanupFilter = filter;
    cleanupUpdate = update;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  const previous = {
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASSWORD,
    host: process.env.MAIL_HOST,
  };
  process.env.MAIL_USER = "";
  process.env.MAIL_PASSWORD = "";
  process.env.MAIL_HOST = "";
  t.after(() => {
    for (const [key, value] of Object.entries({
      MAIL_USER: previous.user,
      MAIL_PASSWORD: previous.password,
      MAIL_HOST: previous.host,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await assert.rejects(
    authService.forgotPassword("  RESET-USER@EXAMPLE.COM "),
    (error) => error.statusCode === 503 &&
      /reset code was not sent/i.test(error.publicMessage || "") &&
      !String(error.publicMessage).includes("123456"),
  );
  assert.deepEqual(lookupFilter, { email: TEST_EMAIL });
  assert.equal(cleanupFilter._id, user._id);
  assert.match(cleanupFilter.passwordResetOtpHash, /^[a-f0-9]{64}$/);
  assert.equal(cleanupUpdate.$set.passwordResetOtpHash, null);
  assert.equal(cleanupUpdate.$set.passwordResetOtpExpires, null);
  assert.equal(cleanupUpdate.$set.passwordResetOtpAttempts, 0);
});
