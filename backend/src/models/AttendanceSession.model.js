const mongoose = require("mongoose");

const AttendanceSessionSchema = new mongoose.Schema(
    {
        sessionId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        courseCode: {
            type: String,
            required: true,
            trim: true,
            uppercase: true
        },

        section: {
            type: String,
            required: true,
            trim: true,
            uppercase: true
        },

        lecturerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        status: {
            type: String,
            enum: ["ACTIVE", "ENDED"],
            default: "ACTIVE",
            index: true
        },

        startedAt: {
            type: Date,
            default: Date.now
        },

        expiresAt: {
            type: Date,
            required: true,
            index: true
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model(
    "AttendanceSession",
    AttendanceSessionSchema
);