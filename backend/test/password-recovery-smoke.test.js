"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runPasswordRecoverySmoke, buildApiBase } = require("../scripts/password-recovery-smoke");

const env = {
  STAGING_BASE_URL: "https://backend.example.test",
  AUTH_RECOVERY_TEST_EMAIL: "reset-smoke@example.test",
  AUTH_RECOVERY_CURRENT_PASSWORD: "Old-Password-123!",
  AUTH_RECOVERY_NEW_PASSWORD: "New-Password-Long-123!",
  STAGING_SMOKE_TIMEOUT_MS: "1000",
};

function createApi({ rejectOldToken = true } = {}) {
  let resetComplete = false;
  const calls = [];
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue));
    const body = options.body ? JSON.parse(options.body) : null;
    const token = options.headers?.Authorization?.replace(/^Bearer\s+/, "");
    calls.push({ path: url.pathname, method: options.method, body, token });

    if (url.pathname.endsWith("/auth/login")) {
      if (!resetComplete && body.password === env.AUTH_RECOVERY_CURRENT_PASSWORD) {
        return new Response(JSON.stringify({ success: true, token: "old-token" }), { status: 200 });
      }
      if (resetComplete && body.password === env.AUTH_RECOVERY_NEW_PASSWORD) {
        return new Response(JSON.stringify({ success: true, token: "new-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: false }), { status: 401 });
    }
    if (url.pathname.endsWith("/auth/forget-password")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.pathname.endsWith("/auth/verify-reset-otp")) {
      return new Response(JSON.stringify({ success: true, resetToken: "A".repeat(43) }), { status: 200 });
    }
    if (url.pathname.endsWith("/auth/reset-password")) {
      assert.equal(body.password, env.AUTH_RECOVERY_NEW_PASSWORD);
      assert.match(body.resetToken, /^[A-Za-z0-9_-]{43}$/);
      resetComplete = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.pathname.endsWith("/auth/me")) {
      if (token === "old-token" && rejectOldToken) {
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  };
  return { fetchImpl, calls };
}

test("normalizes the API base without duplicating /api/v1", () => {
  assert.equal(buildApiBase("https://backend.example.test/"), "https://backend.example.test/api/v1");
  assert.equal(buildApiBase("https://backend.example.test/api/v1/"), "https://backend.example.test/api/v1");
});

test("password recovery smoke verifies OTP, changes password and checks prior credentials are invalidated", async () => {
  const api = createApi();
  const otpPrompts = [];
  const result = await runPasswordRecoverySmoke({
    env,
    fetchImpl: api.fetchImpl,
    otpReader: async () => {
      otpPrompts.push("prompted");
      return "123456";
    },
  });
  assert.deepEqual(result, {
    initialLogin: true,
    otpRequestAccepted: true,
    otpVerified: true,
    passwordChanged: true,
    oldAccessTokenRejected: true,
    oldPasswordRejected: true,
    newPasswordLogin: true,
  });
  assert.deepEqual(otpPrompts, ["prompted"]);
  assert.equal(api.calls.some((call) => call.body?.otp === "123456"), true);
  assert.equal(api.calls.some((call) => call.path.endsWith("/auth/reset-password") && /^[A-Za-z0-9_-]{43}$/.test(call.body?.resetToken || "")), true);
  assert.equal(api.calls.some((call) => call.token === "old-token" && call.path.endsWith("/auth/me")), true);
});

test("password recovery smoke fails closed if old JWT remains valid after reset", async () => {
  const api = createApi({ rejectOldToken: false });
  await assert.rejects(
    runPasswordRecoverySmoke({ env, fetchImpl: api.fetchImpl, otpReader: async () => "123456" }),
    /access token issued before password reset was not rejected/,
  );
});

test("password recovery smoke rejects unsafe or incomplete inputs before network requests", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("unexpected network call");
  };
  await assert.rejects(
    runPasswordRecoverySmoke({
      env: { ...env, STAGING_BASE_URL: "http://backend.example.test" },
      fetchImpl,
      otpReader: async () => "123456",
    }),
    /must use HTTPS/,
  );
  await assert.rejects(
    runPasswordRecoverySmoke({
      env: { ...env, AUTH_RECOVERY_NEW_PASSWORD: "weak" },
      fetchImpl,
      otpReader: async () => "123456",
    }),
    /new password at least 12 characters/,
  );
  assert.equal(called, false);
});
