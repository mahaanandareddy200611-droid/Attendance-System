const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.ATTENDANCE_TOKEN_SECRET = "test-only-attendance-secret-with-enough-entropy";
const { generateAttendanceToken, verifyAttendanceToken } = require("../src/utils/attendanceToken");

test("attendance token round-trips its public session payload", () => {
  const token = generateAttendanceToken({
    sessionId: "session-test-id",
    slot: 123456,
    nonce: "one-time-random-nonce",
  });

  const result = verifyAttendanceToken(token);
  assert.equal(result.valid, true);
  assert.deepEqual(result.payload, {
    sid: "session-test-id",
    slot: 123456,
    nonce: "one-time-random-nonce",
  });
});

test("attendance token rejects a modified signature", () => {
  const token = generateAttendanceToken({
    sessionId: "session-test-id",
    slot: 123456,
    nonce: "one-time-random-nonce",
  });

  const [payload, signature] = token.split(".");
  const result = verifyAttendanceToken(`${payload}.${signature.slice(0, -1)}x`);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "INVALID_SIGNATURE");
});
