"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const BiometricEnrollment = require("../src/models/BiometricEnrollment.model");
const provider = require("../src/modules/Biometric/LocalBiometricProvider");
const service = require("../src/modules/Biometric/BiometricService");

function pendingQuery(rows) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => rows,
  };
}

test("biometric cleanup logs useful network cause codes without identifiers or secrets", async (t) => {
  const pendingEnrollment = {
    _id: "enrollment-id-must-not-be-logged",
    userId: "student-id-must-not-be-logged",
    provider: "LOCAL",
    providerUserId: "provider-person-id-must-not-be-logged",
    modelVersion: "test-model",
  };
  t.mock.method(BiometricEnrollment, "find", () => pendingQuery([pendingEnrollment]));
  t.mock.method(provider, "deletePerson", async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("dns lookup failed"), { code: "ENOTFOUND" }),
    });
  });

  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));

  const result = await service.sweepPendingBiometricDeletes({ limit: 1 });
  assert.deepEqual(result, { scanned: 1, deleted: 0, failed: 1 });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "Pending biometric deletion retry failed");
  assert.deepEqual(logged[0][1], {
    errorName: "TypeError",
    failureKind: "NETWORK_OR_URL",
    causeName: "Error",
    causeCode: "ENOTFOUND",
  });
  const serialized = JSON.stringify(logged);
  assert.equal(serialized.includes(pendingEnrollment.userId), false);
  assert.equal(serialized.includes(pendingEnrollment.providerUserId), false);
});
