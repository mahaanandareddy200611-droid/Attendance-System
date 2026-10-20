"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");

test("one canonical Render Blueprint builds the backend Docker image manually", () => {
  const blueprint = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
  assert.match(blueprint, /runtime:\s*docker/);
  assert.match(blueprint, /dockerfilePath:\s*\.\/backend\/Dockerfile/);
  assert.match(blueprint, /dockerContext:\s*\.\/backend/);
  assert.match(blueprint, /autoDeployTrigger:\s*off/);
  assert.equal(
    fs.existsSync(path.join(root, "backend", "render.yaml")),
    false,
    "The competing Node-runtime Blueprint must remain removed",
  );
});

test("Render uses current backend environment-variable names and requires staging providers", () => {
  const blueprint = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
  const keys = new Set(
    [...blueprint.matchAll(/^\s*- key:\s*([A-Z][A-Z0-9_]*)\s*$/gm)].map((match) => match[1]),
  );

  for (const key of [
    "MONGO_URL", "REDIS_URL", "JWT_SECRET", "ATTENDANCE_TOKEN_SECRET",
    "CORS_ORIGINS", "ATTENDANCE_REQUIRE_BIOMETRIC",
    "ATTENDANCE_REQUIRE_PRIVATE_STORAGE", "ATTENDANCE_REQUIRE_EMAIL",
    "BIOMETRIC_BASE_URL", "BIOMETRIC_API_KEY",
    "OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY",
    "MAIL_USER", "MAIL_PASSWORD", "MAIL_SECURE",
    "ATTENDANCE_EVIDENCE_RETENTION_DAYS", "ATTENDANCE_MAX_GPS_AGE_MS",
  ]) {
    assert.ok(keys.has(key), `Render Blueprint is missing ${key}`);
  }

  for (const staleKey of [
    "BIOMETRIC_SERVICE_URL", "BIOMETRIC_SERVICE_KEY",
    "INSIGHTFACE_AUTH_ENABLED", "INSIGHTFACE_API_KEY", "MAX_GPS_ACCURACY_METERS",
  ]) {
    assert.equal(keys.has(staleKey), false, `Legacy Render key remains: ${staleKey}`);
  }
});

test("environment example documents the feature gates and current provider variables", () => {
  const example = fs.readFileSync(path.join(root, "backend", ".env.example"), "utf8");
  for (const key of [
    "ATTENDANCE_REQUIRE_BIOMETRIC", "ATTENDANCE_REQUIRE_PRIVATE_STORAGE",
    "ATTENDANCE_REQUIRE_EMAIL", "BIOMETRIC_BASE_URL", "OBJECT_STORAGE_ENDPOINT", "MAIL_SECURE",
  ]) {
    assert.match(example, new RegExp(`^${key}=.*$`, "m"));
  }
});
