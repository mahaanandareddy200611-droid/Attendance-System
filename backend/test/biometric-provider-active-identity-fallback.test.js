"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const provider = require("../src/modules/Biometric/LocalBiometricProvider");

test("active-frame detection performs same-frame enrolled identity verification for providers with the legacy detect contract", async (t) => {
  const envKeys = [
    "BIOMETRIC_BASE_URL",
    "BIOMETRIC_API_KEY",
    "BIOMETRIC_COLLECTION_ID",
    "BIOMETRIC_MATCH_THRESHOLD",
    "BIOMETRIC_TIMEOUT_MS",
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries({
    BIOMETRIC_BASE_URL: "https://biometric.example.test",
    BIOMETRIC_API_KEY: "test-only-api-key-that-is-longer-than-32-characters",
    BIOMETRIC_COLLECTION_ID: "students",
    BIOMETRIC_MATCH_THRESHOLD: "0.40",
    BIOMETRIC_TIMEOUT_MS: "30000",
  })) process.env[key] = value;
  const originalFetch = global.fetch;
  const studentId = "507f1f77bcf86cd799439011";
  const otherId = "507f1f77bcf86cd799439012";
  let matchedId = studentId;
  const calledPaths = [];

  global.fetch = async (urlValue, options = {}) => {
    const path = new URL(String(urlValue)).pathname;
    calledPaths.push(path);
    if (path === "/v1/collections/students" && (options.method || "GET") === "GET") {
      return new Response(JSON.stringify({ collection: { id: "students", name: "Attendance students", threshold: 0.4 } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (path === "/v1/detect") {
      return new Response(JSON.stringify({
        faces: [{
          liveness: { status: "ok", is_live: true, live_score: 0.98 },
          landmarks: [[10, 20], [90, 20], [50, 45], [25, 70], [75, 70]],
        }],
        request_id: "detect-request",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/v1/collections/students/search") {
      return new Response(JSON.stringify({
        searched_face: {
          liveness: { status: "ok", is_live: true, live_score: 0.97 },
        },
        matches: [{
          person: { id: matchedId, external_id: matchedId },
          similarity: 0.94,
        }],
        request_id: "identity-request",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Unexpected provider path: " + path);
  };

  t.after(() => {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const accepted = await provider.detect({
    userId: studentId,
    imageBuffer: Buffer.from("same live frame"),
    mimeType: "image/jpeg",
  });
  assert.equal(accepted.identityVerified, true);
  assert.equal(accepted.providerUserId, studentId);
  assert.equal(accepted.identitySimilarity, 0.94);
  assert.equal(accepted.identityVerificationId, "identity-request");
  assert.deepEqual(calledPaths.slice(0, 2), ["/v1/detect", "/v1/collections/students/search"]);

  matchedId = otherId;
  await assert.rejects(
    provider.detect({
      userId: studentId,
      imageBuffer: Buffer.from("same live frame but different identity result"),
      mimeType: "image/jpeg",
    }),
    (error) => error.statusCode === 401 && /(identity does not match|not found among the candidates)/i.test(error.message),
  );
});


test("a missing provider collection is recreated idempotently before face recognition", async (t) => {
  const envKeys = [
    "BIOMETRIC_BASE_URL",
    "BIOMETRIC_API_KEY",
    "BIOMETRIC_COLLECTION_ID",
    "BIOMETRIC_MATCH_THRESHOLD",
    "BIOMETRIC_TIMEOUT_MS",
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    BIOMETRIC_BASE_URL: "https://biometric.example.test",
    BIOMETRIC_API_KEY: "test-only-api-key-that-is-longer-than-32-characters",
    BIOMETRIC_COLLECTION_ID: "auto-repair-test",
    BIOMETRIC_MATCH_THRESHOLD: "0.40",
    BIOMETRIC_TIMEOUT_MS: "30000",
  });
  const originalFetch = global.fetch;
  let exists = false;
  const calls = [];
  global.fetch = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue));
    calls.push({ path: url.pathname, method: options.method || "GET" });
    if (url.pathname === "/v1/collections/auto-repair-test" && (options.method || "GET") === "GET") {
      return new Response(JSON.stringify(exists
        ? { collection: { id: "auto-repair-test", name: "Attendance students", threshold: 0.4 } }
        : { detail: "Collection not found" }), {
        status: exists ? 200 : 404, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/v1/collections" && options.method === "POST") {
      const body = JSON.parse(String(options.body));
      assert.equal(body.id, "auto-repair-test");
      exists = true;
      return new Response(JSON.stringify({
        collection: { id: body.id, name: body.name, threshold: body.threshold },
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Unexpected provider request: " + options.method + " " + url.pathname);
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const first = await provider.ensureCollection();
  assert.equal(first.created, true);
  assert.equal(first.collectionId, "auto-repair-test");
  const second = await provider.ensureCollection();
  assert.equal(second.collectionId, "auto-repair-test");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});
