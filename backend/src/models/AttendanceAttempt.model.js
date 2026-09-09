const mongoose = require("mongoose");

const AttendanceAttemptSchema = new mongoose.Schema(
    {
        sessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AttendanceSession",
            required: false,
            index: true
        },

        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        result: {
            type: String,
            enum: [
                "SUCCESS",
                "INVALID_TOKEN",
                "INVALID_TOKEN_FORMAT",
                "INVALID_TOKEN_PAYLOAD",
                "INVALID_SIGNATURE",
                "TOKEN_EXPIRED",
                "SESSION_NOT_FOUND",
                "SESSION_NOT_ACTIVE",
                "ALREADY_MARKED",
                "INVALID_REQUEST"
            ],
            required: true
        },

        ipAddress: {
            type: String
        },

        userAgent: {
            type: String
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model(
    "AttendanceAttempt",
    AttendanceAttemptSchema
);