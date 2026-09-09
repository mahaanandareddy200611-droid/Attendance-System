const mongoose = require("mongoose");

const AuditEventSchema = new mongoose.Schema(
    {
        event: {
            type: String,
            required: true,
            index: true
        },

        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        },

        sessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AttendanceSession"
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed
        },

        createdAt: {
            type: Date,
            default: Date.now,
            index: true
        }
    }
);

module.exports = mongoose.model(
    "AuditEvent",
    AuditEventSchema
);