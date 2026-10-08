const mongoose = require("mongoose");

const AttendanceSessionSchema =
    new mongoose.Schema(
        {
            /*
            * Public ID used by APIs/clients.
            */
            sessionId: {
                type: String,
                required: true,
                unique: true,
                index: true,
                immutable: true,
                trim: true
            },

            /*
            * Real academic section.
            */
            sectionId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "ClassSection",
                required: true,
                immutable: true
            },

            /*
            * Historical snapshot.
            *
            * Even if the Course/ClassSection is edited later,
            * this session still remembers what class it belonged to.
            */
            courseCode: {
                type: String,
                required: true,
                trim: true,
                uppercase: true,
                immutable: true
            },

            section: {
                type: String,
                required: true,
                trim: true,
                uppercase: true,
                immutable: true
            },

            /*
            * Lecturer who started the session.
            */
            lecturerId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                required: true,
                index: true,
                immutable: true
            },

            /*
            * Session state.
            */
            status: {
                type: String,
                enum: [
                    "ACTIVE",
                    "ENDED",
                    "EXPIRED"
                ],
                default: "ACTIVE",
                index: true
            },

            startedAt: {
                type: Date,
                required: true,
                default: Date.now,
                immutable: true
            },

            expiresAt: {
                type: Date,
                required: true,
                index: true
            },

            endedAt: {
                type: Date,
                default: null
            },

            /*
            * Classroom snapshot.
            */
            classroomSnapshot: {
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
                    max: 1000
                }
            },

            /*
            * Number of students frozen into this session.
            */
            eligibleStudentCount: {
                type: Number,
                required: true,
                min: 0
            },

            /*
            * Used later for concurrency/fencing.
            */
            version: {
                type: Number,
                required: true,
                default: 1
            }
        },
        {
            timestamps: true
        }
    );


/*
 * IMPORTANT:
 *
 * Only ONE ACTIVE session can exist
 * for one section.
 *
 * This is enforced by MongoDB itself.
 */
AttendanceSessionSchema.index(
    {
        sectionId: 1
    },
    {
        unique: true,
        partialFilterExpression: {
            status: "ACTIVE"
        }
    }
);


/*
 * Efficient active/expiry lookup.
 */
AttendanceSessionSchema.index({
    sectionId: 1,
    status: 1,
    expiresAt: 1
});

module.exports =
    mongoose.model(
        "AttendanceSession",
        AttendanceSessionSchema
    );