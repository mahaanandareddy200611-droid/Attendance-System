
const { test } = require("node:test");
const assert = require("node:assert/strict");

const AttendanceRecord = require(
    "../src/models/AttendanceRecord.model"
);

const {
    createOrGetAttendanceRecord
} = require("../src/modules/Attendance/AttendanceRecordService");

function createSession() {
    return {
        withTransaction: async (callback) => callback()
    };
}

function createInput(overrides = {}) {
    return {
        sessionId: "session-123",
        studentId: "student-456",
        courseCode: "CS101",
        section: "A",
        verification: {
            qr: true,
            device: true,
            biometric: true,
            proximity: false
        },
        gps: {
            latitude: 15.4589,
            longitude: 75.0078,
            accuracyMeters: 12,
            capturedAt: new Date(),
            distanceFromClassroomMeters: 8
        },
        dbSession: createSession(),
        ...overrides
    };
}

test("attendance upsert receives the caller's transaction session", async (t) => {
    const expectedRecord = {
        _id: "attendance-1",
        sessionId: "session-123",
        studentId: "student-456"
    };

    let capturedFilter;
    let capturedUpdate;
    let capturedOptions;

    t.mock.method(
        AttendanceRecord,
        "findOneAndUpdate",
        async (filter, update, options) => {
            capturedFilter = filter;
            capturedUpdate = update;
            capturedOptions = options;

            return {
                value: expectedRecord,
                lastErrorObject: {
                    updatedExisting: false
                }
            };
        }
    );

    const input = createInput();
    const result = await createOrGetAttendanceRecord(input);

    assert.deepEqual(capturedFilter, {
        sessionId: input.sessionId,
        studentId: input.studentId
    });

    assert.equal(capturedOptions.session, input.dbSession);
    assert.equal(capturedOptions.upsert, true);
    assert.equal(capturedOptions.includeResultMetadata, true);

    assert.deepEqual(
        capturedUpdate.$setOnInsert.verification,
        input.verification
    );

    assert.equal(result.record, expectedRecord);
    assert.equal(result.created, true);
});

test("existing attendance record is reported as not newly created", async (t) => {
    const existingRecord = {
        _id: "attendance-existing",
        sessionId: "session-123",
        studentId: "student-456"
    };

    t.mock.method(
        AttendanceRecord,
        "findOneAndUpdate",
        async () => ({
            value: existingRecord,
            lastErrorObject: {
                updatedExisting: true
            }
        })
    );

    const result = await createOrGetAttendanceRecord(createInput());

    assert.equal(result.record, existingRecord);
    assert.equal(result.created, false);
});

test("refuses to write attendance without a MongoDB session", async () => {
    await assert.rejects(
        createOrGetAttendanceRecord(
            createInput({ dbSession: null })
        ),
        (error) => {
            assert.equal(error.statusCode, 500);
            assert.match(error.message, /transaction session is required/i);
            return true;
        }
    );
});

test("propagates duplicate-key errors instead of hiding transaction failures", async (t) => {
    const duplicateKeyError = Object.assign(
        new Error("Duplicate attendance record"),
        { code: 11000 }
    );

    t.mock.method(
        AttendanceRecord,
        "findOneAndUpdate",
        async () => {
            throw duplicateKeyError;
        }
    );

    await assert.rejects(
        createOrGetAttendanceRecord(createInput()),
        (error) => error === duplicateKeyError
    );
});
