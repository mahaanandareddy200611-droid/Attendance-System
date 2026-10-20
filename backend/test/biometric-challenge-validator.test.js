const { test } = require("node:test");
const assert = require("node:assert/strict");
const verifySchema = require("../src/modules/Biometric/BiometricValidator").verify;

const base = {
  sessionId: "session-123",
  challengeId: "8d730e8f-28c2-45cb-9b9a-01a6f53c9df0",
  challenge: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno_1234567"
};

// A 32-byte base64url challenge must be exactly 43 characters.
test("biometric verification requires a 43-character base64url challenge", () => {
  const valid = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(valid.length, 43);
  assert.equal(verifySchema.validate({ ...base, challenge: valid }).error, undefined);
});

test("biometric verification rejects a missing challenge response", () => {
  const { challenge, ...withoutChallenge } = base;
  assert.ok(verifySchema.validate(withoutChallenge).error);
});

test("biometric verification rejects malformed challenge responses", () => {
  for (const challenge of ["", "short", "a".repeat(42) + "!"]) {
    assert.ok(verifySchema.validate({ ...base, challenge }).error);
  }
});