const test = require("node:test");
const assert = require("node:assert/strict");
const { validateQr, verifyAttendance } = require("../src/modules/Attendance/AttendanceValidator");

const uuid = "3dc3af1a-9cc7-44d4-8cb2-7757f75d7e25";
const token = "signed-attendance-token-payload.signature";

test("QR-first validation schema accepts a scan token and rejects empty/malformed values", () => {
  assert.equal(validateQr.validate({ token }).error, undefined);
  assert.ok(validateQr.validate({}).error);
  assert.ok(validateQr.validate({ token: "tiny" }).error);
});

test("new attendance API requires only a server-issued ticket plus the biometric assertion", () => {
  assert.equal(verifyAttendance.validate({ validationId: uuid, biometricAssertionId: uuid }).error, undefined);
});

test("attendance verification requires exactly one QR proof mode", () => {
  assert.ok(verifyAttendance.validate({ biometricAssertionId: uuid }).error);
  assert.ok(verifyAttendance.validate({ validationId: uuid, token, biometricAssertionId: uuid }).error);
});

test("legacy clients still need signed device proof and the complete GPS tuple", () => {
  const result = verifyAttendance.validate({
    token,
    biometricAssertionId: uuid,
    deviceId: "test-device-12345678",
    deviceSignature: "a".repeat(64),
    latitude: 15.4589,
    longitude: 75.0078,
    accuracyMeters: 5,
    capturedAt: "2026-10-22T10:00:00.000Z",
  });
  assert.equal(result.error, undefined);
  assert.ok(verifyAttendance.validate({ token, biometricAssertionId: uuid }).error);
});
