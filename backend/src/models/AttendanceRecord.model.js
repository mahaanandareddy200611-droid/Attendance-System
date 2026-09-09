const mongoose = require("mongoose");

const AttendanceRecordSchema = new mongoose.Schema(
    {
        sessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AttendanceSession",
            required: true
        },

        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        courseCode: {
            type: String,
            required: true
        },

        section: {
            type: String,
            required: true
        },

        markedAt: {
            type: Date,
            default: Date.now
        },

        verification: {
            qr: {
                type: Boolean,
                default: true
            },

            device: {
                type: Boolean,
                default: false
            },

            proximity: {
                type: Boolean,
                default: false
            },

            biometric: {
                type: Boolean,
                default: false
            }
        }
    },
    {
        timestamps: true
    }
);

/*
IMPORTANT:

One student can have only ONE attendance
record for one attendance session.
*/
AttendanceRecordSchema.index(
    {
        sessionId: 1,
        studentId: 1
    },
    {
        unique: true
    }
);

module.exports = mongoose.model(
    "AttendanceRecord",
    AttendanceRecordSchema
);