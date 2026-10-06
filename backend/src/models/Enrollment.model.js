const mongoose = require("mongoose");

const EnrollmentSchema = new mongoose.Schema(
    {
        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        sectionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ClassSection",
            required: true,
            index: true
        },

        rollNumber: {
            type: String,
            required: true,
            trim: true,
            uppercase: true
        },

        status: {
            type: String,
            enum: ["ACTIVE", "DROPPED", "COMPLETED"],
            default: "ACTIVE",
            index: true
        }
    },
    {
        timestamps: true
    }
);

EnrollmentSchema.index(
    {
        studentId: 1,
        sectionId: 1
    },
    {
        unique: true
    }
);

EnrollmentSchema.index(
    {
        sectionId: 1,
        rollNumber: 1
    },
    {
        unique: true
    }
);

module.exports = mongoose.model(
    "Enrollment",
    EnrollmentSchema
);