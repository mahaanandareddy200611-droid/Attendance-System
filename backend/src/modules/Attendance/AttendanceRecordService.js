
const AttendanceRecord = require("../../models/AttendanceRecord.model");
const AppError = require("../../utils/AppError");

const createOrGetAttendanceRecord = async ({
    sessionId,
    studentId,
    courseCode,
    section,
    verification,
    gps,
    dbSession
}) => {
    // Attendance records must be written inside the transaction
    // that updates the roster, attempt log, and audit log.
    if (
        !dbSession ||
        typeof dbSession.withTransaction !== "function"
    ) {
        throw new AppError(
            "A MongoDB transaction session is required to write attendance",
            500
        );
    }

    const result = await AttendanceRecord.findOneAndUpdate(
        {
            sessionId,
            studentId
        },
        {
            $setOnInsert: {
                sessionId,
                studentId,
                courseCode,
                section,
                markedAt: new Date(),
                verification,
                gps
            }
        },
        {
            upsert: true,
            returnDocument: "after",
            includeResultMetadata: true,
            setDefaultsOnInsert: true,

            // CRITICAL: participate in the caller's transaction.
            session: dbSession
        }
    );

    const record = result?.value;

    if (!record) {
        throw new AppError(
            "Attendance record could not be created or retrieved",
            500
        );
    }

    return {
        record,
        created:
            result.lastErrorObject?.updatedExisting === false
    };
};

module.exports = {
    createOrGetAttendanceRecord
};
