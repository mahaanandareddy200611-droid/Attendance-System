"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bootstrapBiometricCollection, getBaseUrl } = require("../scripts/bootstrap-biometric-collection");

const env = { BIOMETRIC_BASE_URL: "https://biometric.example.test", BIOMETRIC_API_KEY: "x".repeat(40), BIOMETRIC_COLLECTION_ID: "students" };

test("normalizes provider origin and rejects URL credentials/path", () => {
  assert.equal(getBaseUrl("https://biometric.example.test/"), "https://biometric.example.test");
  assert.throws(() => getBaseUrl("https://user:pass@biometric.example.test"), /without credentials/);
  assert.throws(() => getBaseUrl("https://biometric.example.test/api"), /without credentials/);
});

test("bootstrap creates an empty attendance collection when it does not exist", async () => {
  const calls = [];
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(String(urlValue)); calls.push({ path: url.pathname, method: options.method || "GET", body: options.body });
    if (url.pathname === "/v1/collections/students" && (options.method || "GET") === "GET") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    if (url.pathname === "/v1/collections" && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { id: "students", name: "Attendance students", threshold: 0.4 });
      return new Response(JSON.stringify({ collection: { id: "students" } }), { status: 201 });
    }
    throw new Error("unexpected request");
  };
  const result = await bootstrapBiometricCollection({ env, fetchImpl });
  assert.deepEqual(result, { providerAuthenticated: true, collectionAvailable: true, created: true });
  assert.equal(calls.length, 2);
});

test("bootstrap is idempotent when the collection already exists", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ collection: { id: "students" } }), { status: 200 });
  const result = await bootstrapBiometricCollection({ env, fetchImpl });
  assert.deepEqual(result, { providerAuthenticated: true, collectionAvailable: true, created: false });
});

test("bootstrap requires safe configuration before network requests", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("unexpected request"); };
  await assert.rejects(bootstrapBiometricCollection({ env: { ...env, BIOMETRIC_BASE_URL: "http://public.example.test" }, fetchImpl }), /must use HTTPS/);
  await assert.rejects(bootstrapBiometricCollection({ env: { ...env, BIOMETRIC_API_KEY: "short" }, fetchImpl }), /at least 32 characters/);
  assert.equal(called, false);
});
