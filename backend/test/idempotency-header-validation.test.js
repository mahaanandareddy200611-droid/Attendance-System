const { test } = require("node:test");
const assert = require("node:assert/strict");
const validateIdempotencyKey = require("../src/middlewares/validateIdempotencyKey");

function invoke(value) {
  const req = { get: (name) => name === "Idempotency-Key" ? value : undefined };
  let error;
  let nextCalls = 0;
  validateIdempotencyKey(req, {}, (nextError) => {
    nextCalls += 1;
    error = nextError;
  });
  return { req, error, nextCalls };
}

test("accepts a UUID idempotency key and makes it available to the controller", () => {
  const key = "d6c6b2c4-91a9-4bcb-8e4f-0b9e9f3c1a70";
  const result = invoke(key);
  assert.equal(result.error, undefined);
  assert.equal(result.req.idempotencyKey, key);
  assert.equal(result.nextCalls, 1);
});

test("rejects a missing idempotency key", () => {
  const result = invoke(undefined);
  assert.equal(result.error.statusCode, 400);
  assert.equal(result.nextCalls, 1);
});

test("rejects overlong or unsafe idempotency keys", () => {
  for (const key of ["x".repeat(129), "valid-key-with-space ", "<script>alert(1)</script>"]) {
    const result = invoke(key);
    assert.equal(result.error.statusCode, 400);
  }
});

test("rejects short keys to reduce accidental collisions", () => {
  assert.equal(invoke("tiny-key").error.statusCode, 400);
});
