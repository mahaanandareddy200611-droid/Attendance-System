const crypto = require("crypto");

const mongoose =
    require("mongoose");

const ClassSection =
    require("../../models/ClassSection.model");

const Enrollment =
    require("../../models/Enrollment.model");

const AttendanceSessionStudent =
    require("../../models/AttendanceSessionStudent.model");

const AttendanceSession =
    require("../../models/AttendanceSession.model");
const {
    createOrGetAttendanceRecord
} = require("./AttendanceRecordService");


const AttendanceAttempt =
    require("../../models/AttendanceAttempt.model");

const {
    claimIdempotency,
    completeIdempotency
} = require("./IdempotencyService");
const AuditEvent =
    require("../../models/AuditEvent.model");

const AppError =
    require("../../utils/AppError");

const {
    generateAttendanceToken,
    verifyAttendanceToken,
    isSlotFresh
} = require("../../utils/attendanceToken");

exports.createSession = async ({
    lecturerId,
    sectionId
}) => {

    if (!sectionId) {
        throw new AppError(
            "sectionId is required",
            400
        );
    }

    const dbSession =
        await mongoose.startSession();

    try {

        let createdSession;


        await dbSession.withTransaction(
            async () => {

                /*
                --------------------------------------------------
                1. FIND ACTIVE SECTION
                --------------------------------------------------
                */

                const section =
                    await ClassSection
                        .findOne({
                            _id: sectionId,
                            status: "ACTIVE"
                        })
                        .populate(
                            "courseId",
                            "code name"
                        )
                        .session(dbSession);

                if (!section) {
                    throw new AppError(
                        "Active class section not found",
                        404
                    );
                }


                /*
                --------------------------------------------------
                2. VERIFY LECTURER ASSIGNMENT
                --------------------------------------------------
                */

                const lecturerAssigned =
                    section.lecturers.some(
                        (id) =>
                            String(id) ===
                            String(lecturerId)
                    );

                if (!lecturerAssigned) {
                    throw new AppError(
                        "You are not assigned to this class section",
                        403
                    );
                }


                /*
                --------------------------------------------------
                3. EXPIRE OLD SESSION
                --------------------------------------------------
                */

                const now =
                    new Date();

                await AttendanceSession.updateMany(
                    {
                        sectionId,
                        status: "ACTIVE",
                        expiresAt: {
                            $lte: now
                        }
                    },
                    {
                        $set: {
                            status: "EXPIRED",
                            endedAt: now
                        },
                        $inc: {
                            version: 1
                        }
                    }
                ).session(dbSession);


                /*
                --------------------------------------------------
                4. CHECK ACTIVE SESSION
                --------------------------------------------------
                */

                const existingSession =
                    await AttendanceSession.findOne({
                        sectionId,
                        status: "ACTIVE",
                        expiresAt: {
                            $gt: now
                        }
                    }).session(dbSession);

                if (existingSession) {

                    throw new AppError(
                        "An active attendance session already exists for this section",
                        409
                    );
                }


                /*
                --------------------------------------------------
                5. GET ACTIVE ENROLLMENTS
                --------------------------------------------------
                */

                const enrollments =
                    await Enrollment
                        .find({
                            sectionId,
                            status: "ACTIVE"
                        })
                        .select(
                            "_id studentId rollNumber"
                        )
                        .lean()
                        .session(dbSession);

                if (
                    enrollments.length === 0
                ) {
                    throw new AppError(
                        "No active students are enrolled in this section",
                        400
                    );
                }


                /*
                --------------------------------------------------
                6. SESSION TIMING
                --------------------------------------------------
                */

                const durationMinutes =
                    Number(
                        process.env
                            .ATTENDANCE_SESSION_MINUTES
                    ) || 60;

                const startedAt =
                    now;

                const expiresAt =
                    new Date(
                        startedAt.getTime() +
                        durationMinutes *
                        60 *
                        1000
                    );


                /*
                --------------------------------------------------
                7. CREATE PUBLIC SESSION ID
                --------------------------------------------------
                */

                const sessionId =
                    crypto.randomUUID();


                /*
                --------------------------------------------------
                8. CREATE SESSION
                --------------------------------------------------
                */

                const sessionDocuments =
                    await AttendanceSession.create(
                        [
                            {
                                sessionId,

                                sectionId,

                                courseCode:
                                    section.courseId.code,

                                section:
                                    section.name,

                                lecturerId,

                                status: "ACTIVE",

                                startedAt,

                                expiresAt,

                                endedAt: null,

                                classroomSnapshot: {
                                    code:
                                        section.room.code,

                                    latitude:
                                        section.room.latitude,

                                    longitude:
                                        section.room.longitude,

                                    geofenceRadiusMeters:
                                        section.room
                                            .geofenceRadiusMeters
                                },

                                eligibleStudentCount:
                                    enrollments.length,

                                version: 1
                            }
                        ],
                        {
                            session:
                                dbSession
                        }
                    );

                createdSession =
                    sessionDocuments[0];


                /*
                --------------------------------------------------
                9. FREEZE SESSION ROSTER
                --------------------------------------------------
                */

                const rosterDocuments =
                    enrollments.map(
                        (enrollment) => ({
                            sessionId:
                                createdSession._id,

                            studentId:
                                enrollment.studentId,

                            enrollmentId:
                                enrollment._id,

                            rollNumber:
                                enrollment.rollNumber,

                            status:
                                "ELIGIBLE"
                        })
                    );

                await AttendanceSessionStudent
                    .insertMany(
                        rosterDocuments,
                        {
                            session:
                                dbSession
                        }
                    );


                /*
                --------------------------------------------------
                10. AUDIT
                --------------------------------------------------
                */

                await AuditEvent.create(
                    [
                        {
                            event:
                                "ATTENDANCE_SESSION_CREATED",

                            userId:
                                lecturerId,

                            sessionId:
                                createdSession._id,

                            metadata: {
                                publicSessionId:
                                    sessionId,

                                sectionId,

                                courseCode:
                                    section
                                        .courseId
                                        .code,

                                section:
                                    section.name,

                                eligibleStudentCount:
                                    enrollments.length
                            }
                        }
                    ],
                    {
                        session:
                            dbSession
                    }
                );
            }
        );


        return createdSession;


    } catch (error) {

        /*
        * Concurrent session creation:
        *
        * Two lecturers/requests can race.
        * MongoDB's partial unique index guarantees
        * only one ACTIVE session for this section.
        */

        if (
            error.code === 11000
        ) {

            throw new AppError(
                "An active attendance session already exists for this section",
                409
            );
        }

        throw error;

    } finally {

        await dbSession.endSession();
    }
};


exports.getCurrentQr = async ({
    sessionId,
    lecturerId
}) => {

    const session =
        await AttendanceSession.findOne({
            sessionId,
            lecturerId
        });

    if (!session) {
        throw new AppError(
            "Attendance session not found",
            404
        );
    }

    if (session.status !== "ACTIVE") {
        throw new AppError(
            "Attendance session is not active",
            400
        );
    }

    if (
        new Date() >
        session.expiresAt
    ) {

        session.status = "ENDED";

        await session.save();

        throw new AppError(
            "Attendance session expired",
            400
        );
    }

    const token =
        generateAttendanceToken(
            session.sessionId
        );

    return {
        sessionId: session.sessionId,
        token,
        expiresAt: session.expiresAt
    };
};


exports.endSession = async ({
    sessionId,
    lecturerId
}) => {

    const session =
        await AttendanceSession.findOne({
            sessionId,
            lecturerId
        });

    if (!session) {
        throw new AppError(
            "Attendance session not found",
            404
        );
    }

    if (session.status === "ENDED") {
        return session;
    }

    session.status = "ENDED";

    await session.save();

    await AuditEvent.create({
        event: "ATTENDANCE_SESSION_ENDED",
        userId: lecturerId,
        sessionId: session._id
    });

    return session;
};


exports.verifyAttendance = async ({
    studentId,
    token,
    idempotencyKey,
    ipAddress,
    userAgent
}) => {

    if (!token) {
        throw new AppError(
            "Attendance token is required",
            400
        );
    }

    if (!idempotencyKey) {
        throw new AppError(
            "Idempotency-Key header is required",
            400
        );
    }



    /*
    --------------------------------------------------
    2. VERIFY QR SIGNATURE
    --------------------------------------------------
    */

    const tokenResult =
        verifyAttendanceToken(token);

    if (!tokenResult.valid) {

        await AttendanceAttempt.create({
            studentId,
            result: "INVALID_TOKEN",
            ipAddress,
            userAgent
        });

        throw new AppError(
            "Invalid attendance token",
            401
        );
    }

    const {
        sid,
        slot
    } = tokenResult.payload;

    /*
    --------------------------------------------------
    3. VERIFY TIME SLOT
    --------------------------------------------------
    */

    if (!isSlotFresh(slot)) {

        throw new AppError(
            "Attendance QR has expired",
            401
        );
    }

    /*
    --------------------------------------------------
    4. FIND SESSION
    --------------------------------------------------
    */

    const session =
        await AttendanceSession.findOne({
            sessionId: sid
        });

    if (!session) {
        throw new AppError(
            "Attendance session not found",
            404
        );
    }

    /*
    --------------------------------------------------
    5. SESSION STATUS
    --------------------------------------------------
    */

    if (session.status !== "ACTIVE") {
        throw new AppError(
            "Attendance session is not active",
            400
        );
    }

    if (
        new Date() >
        session.expiresAt
    ) {

        session.status = "ENDED";

        await session.save();

        throw new AppError(
            "Attendance session expired",
            400
        );
    }

/*
--------------------------------------------------
6. ATOMIC IDEMPOTENCY CLAIM
--------------------------------------------------
*/

const idempotencyResult =
    await claimIdempotency({
        key: idempotencyKey,
        studentId,
        sessionId: session._id,
        token
    });

if (idempotencyResult.replayed) {

    return {
        replayed: true,
        status:
            idempotencyResult.responseStatus,
        body:
            idempotencyResult.responseBody
    };
}

const {
    ownerToken
} = idempotencyResult;

   
/*
--------------------------------------------------
7 + 8. ATOMIC ATTENDANCE CREATION
--------------------------------------------------
*/

const {
    record: attendanceRecord,
    created
} = await createOrGetAttendanceRecord({
    sessionId: session._id,
    studentId,
    courseCode: session.courseCode,
    section: session.section,
    verification: {
        qr: true,
        device: false,
        proximity: false,
        biometric: false
    }
});

if (!created) {

    const response = {
        success: true,
        message: "Attendance already marked",
        attendanceId:
            attendanceRecord._id,
        alreadyMarked: true
    };

    await completeIdempotency({
        key: idempotencyKey,
        ownerToken,
        responseStatus: 200,
        responseBody: response
    });

    await AttendanceAttempt.create({
        sessionId: session._id,
        studentId,
        result: "ALREADY_MARKED",
        ipAddress,
        userAgent
    });

    return response;
}

    /*
    --------------------------------------------------
    9. ATTEMPT LOG
    --------------------------------------------------
    */

    await AttendanceAttempt.create({
        sessionId: session._id,
        studentId,
        result: "SUCCESS",
        ipAddress,
        userAgent
    });

    /*
    --------------------------------------------------
    10. AUDIT
    --------------------------------------------------
    */

    await AuditEvent.create({
        event: "ATTENDANCE_MARKED",
        userId: studentId,
        sessionId: session._id,
        metadata: {
    attendanceId:
        attendanceRecord._id
}
    });

    /*
    --------------------------------------------------
    11. IDEMPOTENCY RESPONSE
    --------------------------------------------------
    */

    const response = {
        success: true,
        message:
            "Attendance marked successfully",
        attendanceId:
            attendance._id,
        alreadyMarked: false
    };

    await completeIdempotency({
    key: idempotencyKey,
    ownerToken,
    responseStatus: 201,
    responseBody: response
});

    return response;
};

