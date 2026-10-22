"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BIOMETRIC_BASE_URL = "https://biometric.example.test";
process.env.BIOMETRIC_API_KEY = "test-only-key";
process.env.BIOMETRIC_TIMEOUT_MS = "1000";

const provider = require("../src/modules/Biometric/LocalBiometricProvider");

test("provider health check requires a ready server with API-key auth enabled", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://biometric.example.test/v1/health");
    assert.equal(options.headers.Authorization, "Bearer test-only-key");
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "ready", auth_enabled: true }),
    };
  });
  assert.equal(await provider.checkHealth(), true);
});

test("provider health check fails closed for an unready server", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "starting", auth_enabled: true }),
  }));
  assert.equal(await provider.checkHealth(), false);
});

test("provider health check fails closed for network errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("name lookup failed"), { code: "ENOTFOUND" }),
    });
  });
  assert.equal(await provider.checkHealth(), false);
});
