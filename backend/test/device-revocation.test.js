process.env.REDIS_URL ||= process.env.TEST_REDIS_URL || "redis://127.0.0.1:6380";
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const DeviceCredential = require("../src/models/DeviceCredential.model");
const {
  verifyAttendanceDevice,
} = require("../src/modules/Device/DeviceService");

test("revoked device cannot authorize an attendance request", async (t) => {
  let receivedFilter;

  t.mock.method(DeviceCredential, "findOne", (filter) => {
    receivedFilter = filter;
    return null;
  });

  await assert.rejects(
    verifyAttendanceDevice({
      userId: "student-1",
      deviceId: "phone-1",
      signature: "irrelevant",
      sessionId: "session-1",
      token: "attendance-token",
      idempotencyKey: "operation-1",
    }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.message, "Active device not found");
      return true;
    },
  );

  assert.deepEqual(receivedFilter, {
    userId: "student-1",
    deviceId: "phone-1",
    status: "ACTIVE",
  });
});
