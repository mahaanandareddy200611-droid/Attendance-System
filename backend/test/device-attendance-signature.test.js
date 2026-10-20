"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.REDIS_URL ||= process.env.TEST_REDIS_URL || "redis://127.0.0.1:6380";
const DeviceCredential = require("../src/models/DeviceCredential.model");
const { verifyAttendanceDevice } = require("../src/modules/Device/DeviceService");
const {
    buildAttendanceSignaturePayload
} = require("../src/modules/Device/attendanceSignaturePayload");

function makePayload(overrides = {}) {
    return {
        deviceId: "device-12345678",
        sessionId: "session-12345678",
        token: "signed-qr-token.payload.signature",
        idempotencyKey: "operation-12345678",
        biometricAssertionId: "4bc0d43c-4d24-4b87-95c9-00d0d7656e58",
        latitude: 15.4589,
        longitude: 75.0078,
        accuracyMeters: 5,
        capturedAt: "2026-10-19T10:00:00.000Z",
        ...overrides
    };
}

function signPayload(payload, privateKey) {
    return crypto.sign(
        null,
        Buffer.from(buildAttendanceSignaturePayload(payload), "utf8"),
        privateKey
    ).toString("base64url");
}

test("device signature binds every security-sensitive attendance field", async (t) => {
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const publicKey = keyPair.publicKey.export({ format: "pem", type: "spki" });
    const modelMethods = [
        "findOne",
        "updateOne",
        "findOneAndUpdate",
        "findByIdAndUpdate"
    ];
    const originals = new Map(
        modelMethods.map((method) => [method, DeviceCredential[method]])
    );

    t.after(() => {
        for (const [method, original] of originals) {
            DeviceCredential[method] = original;
        }
    });

    let updateCount = 0;
    let lastFilter;
    const fakeDevice = {
        _id: "device-record-1",
        publicKey,
        status: "ACTIVE",
        save: async () => {
            updateCount += 1;
            return fakeDevice;
        }
    };
    DeviceCredential.findOne = async (filter) => {
        lastFilter = filter;
        return fakeDevice;
    };
    for (const method of ["updateOne", "findOneAndUpdate", "findByIdAndUpdate"]) {
        DeviceCredential[method] = async () => {
            updateCount += 1;
            return { acknowledged: true, modifiedCount: 1, ...fakeDevice };
        };
    }

    const userId = "student-12345678";
    const payload = makePayload();
    const args = {
        userId,
        ...payload,
        signature: signPayload(payload, keyPair.privateKey)
    };

    await assert.doesNotReject(() => verifyAttendanceDevice(args));
    assert.deepEqual(lastFilter, {
        userId,
        deviceId: payload.deviceId,
        status: "ACTIVE"
    });
    const updateCountAfterValidRequest = updateCount;

    const mutations = [
        ["deviceId", "device-87654321"],
        ["sessionId", "session-87654321"],
        ["token", "different-qr-token"],
        ["idempotencyKey", "different-operation-key"],
        ["biometricAssertionId", "c5d8f7fd-5e31-4b81-99e2-fd6dba1ad09a"],
        ["latitude", 15.4591],
        ["longitude", 75.0081],
        ["accuracyMeters", 99],
        ["capturedAt", "2026-10-19T10:00:01.000Z"]
    ];

    for (const [field, changedValue] of mutations) {
        await assert.rejects(
            () => verifyAttendanceDevice({ ...args, [field]: changedValue }),
            /Device signature verification failed/i,
            `expected changing ${field} without a new signature to be rejected`
        );
    }

    assert.equal(
        updateCount,
        updateCountAfterValidRequest,
        "requests with invalid signatures must not update device usage"
    );
});

test("signature payload canonicalizes equivalent numeric and timestamp values", () => {
    const numericValues = buildAttendanceSignaturePayload(makePayload({
        latitude: "15.4589",
        longitude: "75.0078",
        accuracyMeters: "5",
        capturedAt: "2026-10-19T15:30:00+05:30"
    }));
    const normalizedValues = buildAttendanceSignaturePayload(makePayload({
        latitude: 15.4589,
        longitude: 75.0078,
        accuracyMeters: 5,
        capturedAt: "2026-10-19T10:00:00.000Z"
    }));

    assert.equal(numericValues, normalizedValues);
    assert.notEqual(
        buildAttendanceSignaturePayload(makePayload({ latitude: 15.45891 })),
        normalizedValues,
        "a materially changed coordinate must change the signed payload"
    );
});