const mongoose = require("mongoose");

const DeviceCredentialSchema =
    new mongoose.Schema(
        {
            userId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                required: true,
                immutable: true
            },

            deviceId: {
                type: String,
                required: true,
                trim: true,
                immutable: true
            },

            algorithm: {
                type: String,
                enum: [
                    "Ed25519"
                ],
                required: true,
                default: "Ed25519",
                immutable: true
            },

            publicKey: {
                type: String,
                required: true
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

            lastUsedAt: {
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


/*
 * Only ONE active device per student
 * for now.
 *
 * Later we can support multiple
 * approved devices if required.
 */
DeviceCredentialSchema.index(
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


/*
 * A device ID must be globally unique.
 */
DeviceCredentialSchema.index(
    {
        deviceId: 1
    },
    {
        unique: true
    }
);


module.exports =
    mongoose.model(
        "DeviceCredential",
        DeviceCredentialSchema
    );