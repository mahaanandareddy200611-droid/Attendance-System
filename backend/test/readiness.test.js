"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateReadiness } = require("../src/config/readiness");

const env = {
  NODE_ENV: "production",
  ATTENDANCE_RELEASE_CHANNEL: "staging",
  ATTENDANCE_REQUIRE_BIOMETRIC: "true",
  ATTENDANCE_REQUIRE_PRIVATE_STORAGE: "true",
  ATTENDANCE_REQUIRE_EMAIL: "true",
  BIOMETRIC_BASE_URL: "https://biometric.example.test",
  BIOMETRIC_API_KEY: "test-only-key",
  OBJECT_STORAGE_ENDPOINT: "https://objects.example.test",
  OBJECT_STORAGE_BUCKET: "attendance-private",
  OBJECT_STORAGE_ACCESS_KEY_ID: "test-access-key",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
  MAIL_USER: "attendance@example.test",
  MAIL_PASSWORD: "test-mail-password",
  MAIL_HOST: "smtp.example.test",
  MAIL_PORT: "587",
};

test("readiness remains green only when required providers are live", () => {
  const ready = evaluateReadiness({
    env,
    mongoReady: true,
    redisReady: true,
    biometricProviderReady: true,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.dependencies.biometricProvider, true);

  const providerDown = evaluateReadiness({
    env,
    mongoReady: true,
    redisReady: true,
    biometricProviderReady: false,
  });
  assert.equal(providerDown.ready, false);
  assert.equal(providerDown.dependencies.mongodb, true);
  assert.equal(providerDown.dependencies.redis, true);
  assert.equal(providerDown.dependencies.biometricProvider, false);
});
