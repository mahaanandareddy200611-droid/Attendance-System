const mongoose = require("mongoose");

const AuthSchema = new mongoose.Schema(
    {
        Name: {
            type: String,
            required: true,
            trim: true,
        },

        RollNumber: {
            type: String,
            required: function () {
                return this.role === "Student";
            },
            unique: true,
            sparse: true,
            trim: true,
        },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },

        password: {
            type: String,
            required: true,
            select: false,
        },

        mobileNumber: {
            type: String,
            required: true,
            trim: true,
        },

        faceImage_url: {
            type: String,
            required: false,
        },

        role: {
            type: String,
            enum: ["Admin", "Lecturer", "Student"],
            default: "Student",
        },

        passwordResetOtpHash: {
            type: String,
            default: null,
            select: false,
        },

        passwordResetOtpExpires: {
            type: Date,
            default: null,
            select: false,
        },

        passwordResetOtpAttempts: {
            type: Number,
            default: 0,
            select: false,
        },

        passwordResetVerifiedUntil: {
            type: Date,
            default: null,
            select: false,
        }
    },
    {
        timestamps: true,
    }
);

const User = mongoose.model("User", AuthSchema);

module.exports = User;