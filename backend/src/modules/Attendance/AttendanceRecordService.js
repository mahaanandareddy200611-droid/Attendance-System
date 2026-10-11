const AttendanceRecord =
    require("../../models/AttendanceRecord.model");

const createOrGetAttendanceRecord = async ({
    sessionId,
    studentId,
    courseCode,
    section,
    verification,
    gps
}) => {

    try {

        const result =
            await AttendanceRecord.findOneAndUpdate(
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
                    setDefaultsOnInsert: true
                }
            );

        return {
            record: result.value,
            created:
                result.lastErrorObject?.updatedExisting === false
        };

    } catch (error) {

        /*
         * Race protection:
         *
         * Request A and Request B may arrive
         * at almost exactly the same time.
         *
         * The unique index:
         * { sessionId, studentId }
         *
         * guarantees only one record can exist.
         */
        if (error.code === 11000) {

            const existingRecord =
                await AttendanceRecord.findOne({
                    sessionId,
                    studentId
                });

            return {
                record: existingRecord,
                created: false
            };
        }

        throw error;
    }
};

module.exports = {
    createOrGetAttendanceRecord
};
