"use strict";

require("dotenv").config();
const crypto = require("node:crypto");
const readline = require("node:readline/promises");

function buildApiBase(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("Set STAGING_BASE_URL to the deployed backend URL"); }
  const localHttp = ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
  if (url.protocol !== "https:" && !localHttp) throw new Error("STAGING_BASE_URL must use HTTPS outside local development");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("STAGING_BASE_URL must not contain credentials, query, or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = (path.endsWith("/api/v1") ? path : path + "/api/v1").replace(/\/{2,}/g, "/");
  return url.origin + url.pathname;
}

async function readOtpFromInbox() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = await rl.question("Open the test inbox, then enter the 6-digit reset OTP (input is not logged): ");
    return String(value || "").trim();
  } finally {
    rl.close();
  }
}

async function callApi({ baseUrl, path, method = "POST", body, token, fetchImpl, timeoutMs }) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  let response;
  try {
    response = await fetchImpl(baseUrl + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("Staging request could not be completed for " + path);
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function runPasswordRecoverySmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  otpReader = readOtpFromInbox,
} = {}) {
  const baseUrl = buildApiBase(env.STAGING_BASE_URL);
  const email = String(env.AUTH_RECOVERY_TEST_EMAIL || "").trim().toLowerCase();
  const currentPassword = String(env.AUTH_RECOVERY_CURRENT_PASSWORD || "");
  const newPassword = String(env.AUTH_RECOVERY_NEW_PASSWORD || "");
  if (!email || !email.includes("@")) throw new Error("Set AUTH_RECOVERY_TEST_EMAIL to a dedicated staging test account");
  if (currentPassword.length < 6 || newPassword.length < 12 || currentPassword === newPassword) {
    throw new Error("Set distinct AUTH_RECOVERY_CURRENT_PASSWORD and AUTH_RECOVERY_NEW_PASSWORD values (new password at least 12 characters)");
  }
  const timeoutMs = Math.max(1000, Math.min(Number(env.STAGING_SMOKE_TIMEOUT_MS) || 15000, 60000));

  const beforeLogin = await callApi({
    baseUrl, path: "/auth/login", body: { email, password: currentPassword }, fetchImpl, timeoutMs,
  });
  if (beforeLogin.status !== 200 || typeof beforeLogin.data?.token !== "string") {
    throw new Error("Initial login failed for the configured staging test account (HTTP " + beforeLogin.status + ")");
  }
  const oldToken = beforeLogin.data.token;

  const requested = await callApi({ baseUrl, path: "/auth/forget-password", body: { email }, fetchImpl, timeoutMs });
  if (requested.status !== 200 || requested.data?.success !== true) {
    throw new Error("Password-recovery request failed (HTTP " + requested.status + ")");
  }

  const otp = await otpReader();
  if (!/^\d{6}$/.test(String(otp || ""))) throw new Error("The entered reset OTP must contain six digits");
  const verified = await callApi({
    baseUrl, path: "/auth/verify-reset-otp", body: { email, otp: String(otp) }, fetchImpl, timeoutMs,
  });
  if (verified.status !== 200 || verified.data?.success !== true) {
    throw new Error("OTP verification failed (HTTP " + verified.status + ")");
  }
  const resetToken = verified.data?.resetToken;
  if (typeof resetToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(resetToken)) {
    throw new Error("OTP verification did not return a valid one-time reset token");
  }

  const reset = await callApi({
    baseUrl, path: "/auth/reset-password", body: { email, password: newPassword, resetToken }, fetchImpl, timeoutMs,
  });
  if (reset.status !== 200 || reset.data?.success !== true) {
    throw new Error("Password reset failed (HTTP " + reset.status + ")");
  }

  const oldTokenCheck = await callApi({
    baseUrl, path: "/auth/me", method: "GET", token: oldToken, fetchImpl, timeoutMs,
  });
  if (oldTokenCheck.status !== 401) {
    throw new Error("Security failure: the access token issued before password reset was not rejected");
  }

  const oldPasswordLogin = await callApi({
    baseUrl, path: "/auth/login", body: { email, password: currentPassword }, fetchImpl, timeoutMs,
  });
  if (oldPasswordLogin.status !== 401) {
    throw new Error("Security failure: the old password was still accepted after reset (HTTP " + oldPasswordLogin.status + ")");
  }

  const newLogin = await callApi({
    baseUrl, path: "/auth/login", body: { email, password: newPassword }, fetchImpl, timeoutMs,
  });
  if (newLogin.status !== 200 || typeof newLogin.data?.token !== "string") {
    throw new Error("Login with the new password failed (HTTP " + newLogin.status + ")");
  }

  // OTP and tokens are intentionally never printed; only booleans are returned.
  return {
    initialLogin: true,
    otpRequestAccepted: true,
    otpVerified: true,
    passwordChanged: true,
    oldAccessTokenRejected: true,
    oldPasswordRejected: true,
    newPasswordLogin: true,
  };
}

if (require.main === module) {
  runPasswordRecoverySmoke()
    .then((result) => {
      for (const [name, passed] of Object.entries(result)) console.log((passed ? "PASS " : "FAIL ") + name);
      console.log("PASSWORD RECOVERY SMOKE PASSED");
    })
    .catch((error) => {
      console.error("PASSWORD RECOVERY SMOKE FAILED:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { buildApiBase, callApi, runPasswordRecoverySmoke };
