const mongoose = require("mongoose");

const ClassSectionSchema = new mongoose.Schema(
    {
        courseId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Course",
            required: true,
            index: true
        },

        name: {
            type: String,
            required: true,
            trim: true,
            uppercase: true
        },

        academicYear: {
            type: String,
            required: true,
            trim: true
        },

        semester: {
            type: Number,
            required: true,
            min: 1,
            max: 12
        },

        room: {
            code: {
                type: String,
                required: true,
                trim: true,
                uppercase: true
            },

            latitude: {
                type: Number,
                required: true,
                min: -90,
                max: 90
            },

            longitude: {
                type: Number,
                required: true,
                min: -180,
                max: 180
            },

            geofenceRadiusMeters: {
                type: Number,
                required: true,
                min: 5,
                max: 1000,
                default: 100
            }
        },

        lecturers: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User"
            }
        ],

        status: {
            type: String,
            enum: ["ACTIVE", "INACTIVE"],
            default: "ACTIVE",
            index: true
        }
    },
    {
        timestamps: true
    }
);

ClassSectionSchema.index(
    {
        courseId: 1,
        name: 1,
        academicYear: 1,
        semester: 1
    },
    {
        unique: true
    }
);

module.exports =
    mongoose.model(
        "ClassSection",
        ClassSectionSchema
    );