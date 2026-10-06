const mongoose = require("mongoose");

const CourseSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            uppercase: true,
            index: true
        },

        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 150
        },

        department: {
            type: String,
            required: true,
            trim: true,
            uppercase: true
        },

        semester: {
            type: Number,
            required: true,
            min: 1,
            max: 12
        },

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

module.exports = mongoose.model(
    "Course",
    CourseSchema
);