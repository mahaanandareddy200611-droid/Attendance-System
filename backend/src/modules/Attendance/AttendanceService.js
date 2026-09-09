const crypto = require("crypto");

const AttendanceSession =
    require("../../models/AttendanceSession.model");

const AttendanceRecord =
    require("../../models/AttendanceRecord.model");

const AttendanceAttempt =
    require("../../models/AttendanceAttempt.model");

const Idempotency =
    require("../../models/Idempotency.model");

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
    courseCode,
    section
}) => {

    if (!courseCode || !section) {
        throw new AppError(
            "courseCode and section are required",
            400
        );
    }

    const durationMinutes =
        Number(
            process.env.ATTENDANCE_SESSION_MINUTES
        ) || 60;

    const sessionId =
        crypto.randomUUID();

    const startedAt = new Date();

    const expiresAt =
        new Date(
            startedAt.getTime() +
            durationMinutes * 60 * 1000
        );

    const session =
        await AttendanceSession.create({
            sessionId,
            courseCode,
            section,
            lecturerId,
            status: "ACTIVE",
            startedAt,
            expiresAt
        });

    await AuditEvent.create({
        event: "ATTENDANCE_SESSION_CREATED",
        userId: lecturerId,
        sessionId: session._id,
        metadata: {
            courseCode,
            section
        }
    });

    return session;
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
    1. CHECK IDEMPOTENCY
    --------------------------------------------------
    */

    const existingRequest =
        await Idempotency.findOne({
            key: idempotencyKey
        });

    if (existingRequest) {

        if (
            String(existingRequest.studentId)
            !== String(studentId)
        ) {
            throw new AppError(
                "Idempotency key belongs to another user",
                409
            );
        }

        if (
            existingRequest.status ===
            "COMPLETED"
        ) {

            return {
                replayed: true,
                status: existingRequest.responseStatus,
                body: existingRequest.responseBody
            };
        }
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
    6. CREATE IDEMPOTENCY RECORD
    --------------------------------------------------
    */

    try {

        await Idempotency.create({
            key: idempotencyKey,
            studentId,
            sessionId: session._id,
            status: "PROCESSING"
        });

    } catch (error) {

        if (
            error.code === 11000
        ) {

            const request =
                await Idempotency.findOne({
                    key: idempotencyKey
                });

            if (
                request &&
                request.status === "COMPLETED"
            ) {

                return {
                    replayed: true,
                    status:
                        request.responseStatus,
                    body:
                        request.responseBody
                };
            }

        } else {
            throw error;
        }
    }

    /*
    --------------------------------------------------
    7. CHECK WHETHER ALREADY MARKED
    --------------------------------------------------
    */

    const existingAttendance =
        await AttendanceRecord.findOne({
            sessionId: session._id,
            studentId
        });

    if (existingAttendance) {

        const response = {
            success: true,
            message:
                "Attendance already marked",
            attendanceId:
                existingAttendance._id,
            alreadyMarked: true
        };

        await Idempotency.updateOne(
            { key: idempotencyKey },
            {
                $set: {
                    status: "COMPLETED",
                    responseStatus: 200,
                    responseBody: response
                }
            }
        );

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
    8. CREATE ATTENDANCE
    --------------------------------------------------
    */

    let attendance;

    try {

        attendance =
            await AttendanceRecord.create({
                sessionId: session._id,
                studentId,
                courseCode:
                    session.courseCode,
                section:
                    session.section,
                markedAt: new Date(),

                verification: {
                    qr: true,
                    device: false,
                    proximity: false,
                    biometric: false
                }
            });

    } catch (error) {

        /*
        MongoDB unique index protects us
        against race-condition duplicates.
        */

        if (
            error.code === 11000
        ) {

            const existing =
                await AttendanceRecord.findOne({
                    sessionId:
                        session._id,
                    studentId
                });

            const response = {
                success: true,
                message:
                    "Attendance already marked",
                attendanceId:
                    existing?._id,
                alreadyMarked: true
            };

            await Idempotency.updateOne(
                { key: idempotencyKey },
                {
                    $set: {
                        status: "COMPLETED",
                        responseStatus: 200,
                        responseBody: response
                    }
                }
            );

            return response;
        }

        throw error;
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
                attendance._id
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

    await Idempotency.updateOne(
        { key: idempotencyKey },
        {
            $set: {
                status: "COMPLETED",
                responseStatus: 201,
                responseBody: response
            }
        }
    );

    return response;
};

