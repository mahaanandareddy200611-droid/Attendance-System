const mongoose = require("mongoose");

const BiometricEnrollmentSchema =
    new mongoose.Schema(
        {
            userId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                required: true,
                immutable: true
            },

            provider: {
                type: String,
                enum: [
                    "LOCAL",
                    "AWS",
                    "OTHER"
                ],
                required: true
            },

            providerUserId: {
                type: String,
                required: true,
                trim: true
            },

            modelVersion: {
                type: String,
                required: true,
                trim: true
            },

            status: {
                type: String,
                enum: [
                    "ACTIVE",
                    "REVOKED"
                ],
                default: "ACTIVE",
                index: true
            },

            enrolledAt: {
                type: Date,
                default: Date.now
            },

            lastVerifiedAt: {
                type: Date,
                default: null
            },

            revokedAt: {
                type: Date,
                default: null
            }
        },
        {
            timestamps: true
        }
    );


BiometricEnrollmentSchema.index(
    {
        userId: 1
    },
    {
        unique: true,
        partialFilterExpression: {
            status: "ACTIVE"
        }
    }
);


BiometricEnrollmentSchema.index({
    provider: 1,
    providerUserId: 1
});


module.exports =
    mongoose.model(
        "BiometricEnrollment",
        BiometricEnrollmentSchema
    );