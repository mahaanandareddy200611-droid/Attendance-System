const mongoose = require("mongoose");

const IdempotencySchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },

        fingerprint: {
            type: String,
            required: true
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
            required: true,
            default: "PROCESSING"
        },

        responseStatus: {
            type: Number,
            default: null
        },

        responseBody: {
            type: mongoose.Schema.Types.Mixed,
            default: null
        },

        ownerToken: {
            type: String,
            default: null
        },

        leaseUntil: {
            type: Date,
            default: null,
            index: true
        },

        createdAt: {
            type: Date,
            default: Date.now,
            expires: 60 * 10
        }
    }
);

IdempotencySchema.index(
    { key: 1 },
    { unique: true }
);

module.exports = mongoose.model(
    "Idempotency",
    IdempotencySchema
);