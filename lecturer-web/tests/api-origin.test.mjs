import assert from "node:assert/strict";
import test from "node:test";
import { resolveApiBaseUrl } from "../src/api/apiOrigin.js";

test("uses localhost only for unconfigured local development", () => {
  assert.equal(resolveApiBaseUrl("", { dev: true }), "http://localhost:3000/api/v1");
});

test("requires an explicit HTTPS API origin for production", () => {
  assert.throws(() => resolveApiBaseUrl("", { dev: false }), /must be set/);
  assert.equal(resolveApiBaseUrl("https://api.example.test/api/v1", { dev: false }), "https://api.example.test/api/v1");
});

test("rejects HTTP except loopback development URLs", () => {
  assert.equal(resolveApiBaseUrl("http://127.0.0.1:3000/api/v1", { dev: true }), "http://127.0.0.1:3000/api/v1");
  assert.throws(() => resolveApiBaseUrl("http://api.example.test/api/v1", { dev: true }), /must use HTTPS/);
});

test("rejects credentials, query strings, and incorrect API paths", () => {
  for (const value of [
    "https://user:secret@api.example.test/api/v1",
    "https://api.example.test/api/v1?token=secret",
    "https://api.example.test/api/v2",
    "https://api.example.test/api/v1/extra",
  ]) assert.throws(() => resolveApiBaseUrl(value, { dev: false }));
});
