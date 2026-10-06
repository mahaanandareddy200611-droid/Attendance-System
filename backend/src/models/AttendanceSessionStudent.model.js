const mongoose = require("mongoose");

const AttendanceSessionStudentSchema =
    new mongoose.Schema(
        {
            sessionId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "AttendanceSession",
                required: true,
                index: true
            },

            studentId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                required: true,
                index: true
            },

            enrollmentId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Enrollment",
                required: true
            },

            rollNumber: {
                type: String,
                required: true,
                trim: true,
                uppercase: true
            },

            status: {
                type: String,
                enum: [
                    "ELIGIBLE",
                    "PRESENT",
                    "LATE",
                    "ABSENT",
                    "EXCUSED"
                ],
                default: "ELIGIBLE",
                index: true
            }
        },
        {
            timestamps: true
        }
    );

/*
 * A student can appear only once in one session.
 */
AttendanceSessionStudentSchema.index(
    {
        sessionId: 1,
        studentId: 1
    },
    {
        unique: true
    }
);

/*
 * A roll number can appear only once in one session.
 */
AttendanceSessionStudentSchema.index(
    {
        sessionId: 1,
        rollNumber: 1
    },
    {
        unique: true
    }
);

module.exports = mongoose.model(
    "AttendanceSessionStudent",
    AttendanceSessionStudentSchema
);