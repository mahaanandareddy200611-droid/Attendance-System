const mongoose = require("mongoose");

const IdempotencySchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        sessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AttendanceSession",
            required: true
        },

        status: {
            type: String,
            enum: ["PROCESSING", "COMPLETED"],
            default: "PROCESSING"
        },

        responseStatus: {
            type: Number
        },

        responseBody: {
            type: mongoose.Schema.Types.Mixed
        },

        createdAt: {
            type: Date,
            default: Date.now,
            expires: 60 * 10
        }
    }
);

module.exports = mongoose.model(
    "Idempotency",
    IdempotencySchema
);