"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const provider = require("../src/modules/Biometric/LocalBiometricProvider");

function setProviderEnvironment(t) {
  const keys = ["BIOMETRIC_BASE_URL", "BIOMETRIC_API_KEY", "BIOMETRIC_COLLECTION_ID"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.BIOMETRIC_BASE_URL = "https://biometric.example";
  process.env.BIOMETRIC_API_KEY = "test-api-key";
  process.env.BIOMETRIC_COLLECTION_ID = "students";
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

function personResponse(faces, rejectedImages = []) {
  return new Response(JSON.stringify({
    person: { id: "opaque-provider-person" },
    faces,
    rejected_images: rejectedImages,
    request_id: "provider-request-test"
  }), { status: 201, headers: { "content-type": "application/json" } });
}

test("enrollment rejects a provider response with no accepted face and deletes the empty profile", async (t) => {
  setProviderEnvironment(t);
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET" });
    if ((options.method || "GET") === "POST") return personResponse([]);
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    return new Response("unexpected request", { status: 400 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    provider.enroll({ userId: "507f1f77bcf86cd799439011", imageBuffer: Buffer.from("test"), mimeType: "image/jpeg" }),
    (error) => error.statusCode === 422 && /No usable face was detected/.test(error.message),
  );
  assert.deepEqual(requests.map((item) => item.method), ["POST", "DELETE"]);
  assert.match(requests[1].url, /\/v1\/collections\/students\/persons\/opaque-provider-person$/);
});

test("enrollment accepts exactly one provider-accepted face", async (t) => {
  setProviderEnvironment(t);
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    if ((options.method || "GET") === "POST") return personResponse([{ id: "face-1" }]);
    return new Response(null, { status: 204 });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await provider.enroll({
    userId: "507f1f77bcf86cd799439011",
    imageBuffer: Buffer.from("test"),
    mimeType: "image/jpeg",
  });
  assert.equal(result.providerUserId, "opaque-provider-person");
  assert.equal(result.acceptedFaces, 1);
});

test("rejected enrollment exposes cleanup job details internally if provider deletion fails", async (t) => {
  setProviderEnvironment(t);
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    if ((options.method || "GET") === "POST") return personResponse([], ["no face"]);
    return new Response(JSON.stringify({ message: "denied" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    provider.enroll({ userId: "507f1f77bcf86cd799439011", imageBuffer: Buffer.from("test"), mimeType: "image/jpeg" }),
    (error) => error.statusCode === 503 &&
      error.cleanupProviderUserId === "opaque-provider-person" &&
      /cleanup is pending/.test(error.message),
  );
});
