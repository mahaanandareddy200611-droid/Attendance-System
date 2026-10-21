"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runBiometricProviderSmoke } = require("../scripts/biometric-provider-smoke");

function stubProvider({ live = true, match = true } = {}) {
  let externalId = null;
  let deleted = false;
  let enrolled = false;
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue));
    const method = options.method || "GET";
    if (url.pathname === "/v1/health" && method === "GET") {
      return new Response(JSON.stringify({ status: "ready", auth_enabled: true }), { status: 200 });
    }
    if (url.pathname === "/v1/collections/students" && method === "GET") {
      return new Response(JSON.stringify({ collection: { id: "students" } }), { status: 200 });
    }
    if (url.pathname === "/v1/detect" && method === "POST") {
      return new Response(JSON.stringify({
        faces: [{
          landmarks: [[1, 1], [5, 1], [3, 3], [2, 5], [4, 5]],
          liveness: { status: "ok", is_live: live, live_score: live ? 0.98 : 0.01 },
        }],
      }), { status: 200 });
    }
    if (url.pathname === "/v1/collections/students/persons" && method === "POST") {
      externalId = options.body.get("external_id");
      enrolled = true;
      return new Response(JSON.stringify({
        person: { id: externalId, external_id: externalId },
        faces: [{ id: "sample-1" }],
        rejected_images: [],
      }), { status: 201 });
    }
    if (url.pathname === "/v1/collections/students/search" && method === "POST") {
      return new Response(JSON.stringify({
        searched_face: { liveness: { status: "ok", is_live: true, live_score: 0.97 } },
        matches: match ? [{ person: { external_id: externalId }, similarity: 0.94 }] : [],
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/persons/" + externalId) && method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected provider stub request: " + method + " " + url.pathname);
  };
  return {
    fetchImpl,
    get state() { return { deleted, enrolled }; },
  };
}

const env = {
  BIOMETRIC_BASE_URL: "https://biometric.example.test",
  BIOMETRIC_API_KEY: "test-only-api-key",
  BIOMETRIC_COLLECTION_ID: "students",
  BIOMETRIC_MATCH_THRESHOLD: "0.7",
  BIOMETRIC_TIMEOUT_MS: "2000",
};

function readImage(_env, key) {
  return Promise.resolve({
    imageBuffer: Buffer.from(key),
    type: "image/jpeg",
    fileName: key + ".jpg",
  });
}

test("real-provider smoke exercises authenticated detect, liveness, enrollment, search, and cleanup", async () => {
  const provider = stubProvider();
  const result = await runBiometricProviderSmoke({ env, fetchImpl: provider.fetchImpl, readImage });
  assert.deepEqual(result, {
    providerReady: true,
    apiKeyAuthEnabled: true,
    collectionAccessible: true,
    faceDetection: true,
    stillImageLiveness: true,
    identityMatch: true,
    temporaryEnrollmentDeleted: true,
  });
  assert.deepEqual(provider.state, { deleted: true, enrolled: true });
});

test("smoke rejects a negative liveness result before enrollment", async () => {
  const provider = stubProvider({ live: false });
  await assert.rejects(
    runBiometricProviderSmoke({ env, fetchImpl: provider.fetchImpl, readImage }),
    /passing, evaluated liveness result/,
  );
  assert.deepEqual(provider.state, { deleted: false, enrolled: false });
});

test("smoke deletes the temporary provider identity when matching fails", async () => {
  const provider = stubProvider({ match: false });
  await assert.rejects(
    runBiometricProviderSmoke({ env, fetchImpl: provider.fetchImpl, readImage }),
    /did not match the second capture to the enrolled test identity/,
  );
  assert.deepEqual(provider.state, { deleted: true, enrolled: true });
});

test("provider base URL rejects credentials and non-HTTPS external endpoints", async () => {
  await assert.rejects(
    runBiometricProviderSmoke({
      env: { ...env, BIOMETRIC_BASE_URL: "https://user:pass@biometric.example.test" },
      fetchImpl: async () => { throw new Error("must not send request"); },
      readImage,
    }),
    /must be an origin/,
  );
  await assert.rejects(
    runBiometricProviderSmoke({
      env: { ...env, BIOMETRIC_BASE_URL: "http://biometric.example.test" },
      fetchImpl: async () => { throw new Error("must not send request"); },
      readImage,
    }),
    /must use HTTPS/,
  );
});
