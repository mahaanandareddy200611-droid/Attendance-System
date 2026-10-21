const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.ATTENDANCE_TOKEN_SECRET = "test-only-attendance-secret-with-enough-entropy";
process.env.QR_REFRESH_MS = "1000";
process.env.QR_ALLOWED_SKEW_SLOTS = "1";
const {
  generateAttendanceToken,
  verifyAttendanceToken,
  isSlotFresh,
  getSlotExpiry
} = require("../src/utils/attendanceToken");

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


test("attendance QR slot freshness accepts only the current or explicitly allowed previous slots", () => {
  const now = 10_000; // current slot 10 with a 1-second slot duration

  assert.equal(isSlotFresh(10, now), true);
  assert.equal(isSlotFresh(9, now), true, "one previous slot is allowed by configuration");
  assert.equal(isSlotFresh(8, now), false, "slots outside the configured skew must expire");
  assert.equal(isSlotFresh(11, now), false, "future slots must never be accepted");
  assert.equal(isSlotFresh(10.5, now), false, "fractional slots are invalid");
  assert.equal(isSlotFresh("10", now), false, "slot values must have the canonical numeric type");
  assert.equal(getSlotExpiry(10).getTime(), 12_000, "expiry must match the end of the last accepted slot");
});

test("a zero QR skew setting is respected instead of falling back to one slot", () => {
  const modulePath = require.resolve("../src/utils/attendanceToken");
  const previousSetting = process.env.QR_ALLOWED_SKEW_SLOTS;

  try {
    process.env.QR_ALLOWED_SKEW_SLOTS = "0";
    delete require.cache[modulePath];
    const zeroSkew = require("../src/utils/attendanceToken");

    assert.equal(zeroSkew.isSlotFresh(10, 10_000), true);
    assert.equal(zeroSkew.isSlotFresh(9, 10_000), false);
    assert.equal(zeroSkew.getSlotExpiry(10).getTime(), 11_000);
  } finally {
    if (previousSetting === undefined) {
      delete process.env.QR_ALLOWED_SKEW_SLOTS;
    } else {
      process.env.QR_ALLOWED_SKEW_SLOTS = previousSetting;
    }
    delete require.cache[modulePath];
    require("../src/utils/attendanceToken");
  }
});

test("attendance tokens reject non-numeric slot payloads even when correctly signed", () => {
  const stringSlotToken = generateAttendanceToken({
    sessionId: "session-test-id",
    slot: "123456",
    nonce: "one-time-random-nonce"
  });
  const result = verifyAttendanceToken(stringSlotToken);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "INVALID_TOKEN_PAYLOAD");
});
