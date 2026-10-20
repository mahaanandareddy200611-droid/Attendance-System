"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRuntimeConfig } = require("../src/config/runtimeConfig");

const valid = {
  MONGO_URL: "mongodb://127.0.0.1:27017/attendance_system",
  REDIS_URL: "rediss://redis.example.test:6380",
  JWT_SECRET: "test-jwt-secret-with-at-least-32-characters",
  ATTENDANCE_TOKEN_SECRET: "different-test-token-secret-with-32-characters",
  CORS_ORIGINS: "https://lecturer.example.test",
  ATTENDANCE_REQUIRE_BIOMETRIC: "true",
  BIOMETRIC_BASE_URL: "https://biometric.example.test",
  BIOMETRIC_API_KEY: "test-biometric-key",
  ATTENDANCE_REQUIRE_PRIVATE_STORAGE: "true",
  OBJECT_STORAGE_ENDPOINT: "https://example-account.r2.cloudflarestorage.com",
  OBJECT_STORAGE_BUCKET: "attendance-private",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_ACCESS_KEY_ID: "test-access-key",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
  ATTENDANCE_REQUIRE_EMAIL: "true",
  MAIL_USER: "mailer@example.test",
  MAIL_PASSWORD: "test-mail-password",
  MAIL_HOST: "smtp.example.test",
  MAIL_PORT: "587",
  MAIL_SECURE: "false",
};

test("full staging runtime configuration passes validation", () => {
  assert.deepEqual(validateRuntimeConfig(valid), { valid: true });
});

test("missing required config reports names without exposing secret values", () => {
  const invalid = {
    ...valid,
    REDIS_URL: "",
    BIOMETRIC_API_KEY: "",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "",
    MAIL_PASSWORD: "",
  };

  assert.throws(() => validateRuntimeConfig(invalid), (error) => {
    assert.ok(error.missingOrInvalid.includes("REDIS_URL"));
    assert.ok(error.missingOrInvalid.includes("BIOMETRIC_API_KEY"));
    assert.ok(error.missingOrInvalid.includes("OBJECT_STORAGE_SECRET_ACCESS_KEY"));
    assert.ok(error.missingOrInvalid.some((key) => key.startsWith("MAIL_USER")));
    assert.equal(error.message.includes(valid.OBJECT_STORAGE_SECRET_ACCESS_KEY), false);
    assert.equal(error.message.includes(valid.MAIL_PASSWORD), false);
    return true;
  });
});

test("invalid SMTP port is rejected before the server starts", () => {
  assert.throws(
    () => validateRuntimeConfig({ ...valid, MAIL_PORT: "70000" }),
    (error) => error.missingOrInvalid.some((key) => key.includes("MAIL_PORT")),
  );
});

test("weak and reused JWT signing secrets are rejected", () => {
  assert.throws(
    () => validateRuntimeConfig({ ...valid, JWT_SECRET: "short" }),
    (error) => error.missingOrInvalid.some((key) => key.startsWith("JWT_SECRET")),
  );
  assert.throws(
    () => validateRuntimeConfig({ ...valid, ATTENDANCE_TOKEN_SECRET: valid.JWT_SECRET }),
    (error) => error.missingOrInvalid.some((key) => key.startsWith("JWT_SECRET and ATTENDANCE_TOKEN_SECRET")),
  );
});

test("development requires database and sufficiently strong auth settings but not external feature providers", () => {
  const env = {
    MONGO_URL: valid.MONGO_URL,
    REDIS_URL: "redis://127.0.0.1:6379",
    JWT_SECRET: valid.JWT_SECRET,
    ATTENDANCE_TOKEN_SECRET: valid.ATTENDANCE_TOKEN_SECRET,
  };
  assert.deepEqual(validateRuntimeConfig(env), { valid: true });
});


test("managed MongoDB and Redis URIs with credentials are accepted", () => {
  const env = {
    MONGO_URL: "mongodb+srv://attendance_user:encoded%40password@cluster.example.test/attendance?retryWrites=true&w=majority",
    REDIS_URL: "rediss://default:encoded%40password@redis.example.test:6380/0",
    JWT_SECRET: valid.JWT_SECRET,
    ATTENDANCE_TOKEN_SECRET: valid.ATTENDANCE_TOKEN_SECRET,
  };
  assert.deepEqual(validateRuntimeConfig(env), { valid: true });
});

test("provider URLs cannot embed credentials", () => {
  assert.throws(
    () => validateRuntimeConfig({
      ...valid,
      BIOMETRIC_BASE_URL: "https://user:password@biometric.example.test",
    }),
    (error) => error.missingOrInvalid.includes("BIOMETRIC_BASE_URL"),
  );
});
