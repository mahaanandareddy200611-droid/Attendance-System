"use strict";

const enabled = (env, key) =>
  String(env[key] || "").trim().toLowerCase() === "true";

/**
 * A null/undefined probe result means "not probed" and falls back to
 * configuration-only status for callers that use this pure helper.
 * The live /readyz route supplies the actual biometric-provider probe result.
 */
function evaluateReadiness({
  env = process.env,
  mongoReady = false,
  redisReady = false,
  biometricProviderReady,
} = {}) {
  const biometricConfigured = Boolean(
    env.BIOMETRIC_BASE_URL && env.BIOMETRIC_API_KEY,
  );
  const biometricProvider = biometricProviderReady === undefined
    ? biometricConfigured
    : Boolean(biometricProviderReady);
  const privateStorage = Boolean(
    env.OBJECT_STORAGE_ENDPOINT &&
      env.OBJECT_STORAGE_BUCKET &&
      env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  );
  const email = Boolean(
    env.MAIL_USER &&
      env.MAIL_PASSWORD &&
      (!env.MAIL_HOST ||
        (Number.isInteger(Number(env.MAIL_PORT)) &&
          Number(env.MAIL_PORT) >= 1 &&
          Number(env.MAIL_PORT) <= 65535)),
  );
  const prod =
    env.NODE_ENV === "production" &&
    String(env.ATTENDANCE_RELEASE_CHANNEL || "production").toLowerCase() === "production" &&
    (env.RENDER === "true" || Boolean(env.RENDER_SERVICE_ID));

  const requirements = {
    biometric: enabled(env, "ATTENDANCE_REQUIRE_BIOMETRIC") || prod,
    privateStorage: enabled(env, "ATTENDANCE_REQUIRE_PRIVATE_STORAGE"),
    email: enabled(env, "ATTENDANCE_REQUIRE_EMAIL"),
  };
  const approved = String(env.BIOMETRIC_PRODUCTION_APPROVED || "").toLowerCase() === "true";
  const dependencies = {
    mongodb: Boolean(mongoReady),
    redis: Boolean(redisReady),
    biometricProvider,
    biometricReleaseApproved: approved,
    privateObjectStorage: privateStorage,
    email,
  };
  const ready =
    dependencies.mongodb &&
    dependencies.redis &&
    (!requirements.biometric || (biometricProvider && (!prod || approved))) &&
    (!requirements.privateStorage || privateStorage) &&
    (!requirements.email || email);

  return { ready: Boolean(ready), dependencies, requirements };
}

module.exports = { evaluateReadiness };
