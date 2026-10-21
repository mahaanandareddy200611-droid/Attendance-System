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


test("Render Blueprint wires the lecturer site to the backend origin with matching CORS", () => {
  const blueprint = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
  assert.match(blueprint, /name:\s*attendance-backend-staging/);
  assert.match(blueprint, /name:\s*attendance-lecturer-staging/);
  assert.match(blueprint, /runtime:\s*static/);
  assert.match(blueprint, /autoDeployTrigger:\s*off/);
  assert.match(blueprint, /VITE_API_BASE_URL[\s\S]{0,120}https:\/\/attendance-backend-staging\.onrender\.com\/api\/v1/);
  assert.match(blueprint, /CORS_ORIGINS\s*\n\s*value:\s*https:\/\/attendance-lecturer-staging\.onrender\.com/);
  assert.match(blueprint, /source:\s*\/\*/);
  assert.match(blueprint, /destination:\s*\/index\.html/);
});

test("biometric Render blueprint keeps licensing explicit, data persistent, and model API private", () => {
  const blueprint = fs.readFileSync(path.join(root, "biometric-provider", "render.yaml"), "utf8");
  const entrypoint = fs.readFileSync(path.join(root, "biometric-provider", "entrypoint.sh"), "utf8");
  const config = fs.readFileSync(path.join(root, "biometric-provider", "server.toml"), "utf8");
  assert.match(blueprint, /plan:\s*1c-2g/);
  assert.match(blueprint, /mountPath:\s*\/data/);
  assert.match(blueprint, /sizeGB:\s*5/);
  assert.match(blueprint, /INSIGHTFACE_API_KEY[\s\S]{0,30}sync:\s*false/);
  assert.match(blueprint, /BIOMETRIC_MODEL_LICENSE_ACCEPTED[\s\S]{0,30}sync:\s*false/);
  assert.match(entrypoint, /BIOMETRIC_MODEL_LICENSE_ACCEPTED:-false/);
  assert.match(entrypoint, /INSIGHTFACE_API_KEY/);
  assert.match(config, /liveness_on_registration\s*=\s*true/);
  assert.match(config, /\[web\]\s*\ndisabled\s*=\s*true/);
});
