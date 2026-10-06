const Joi = require("joi");

exports.createCourse = Joi.object({
    code: Joi.string()
        .trim()
        .uppercase()
        .min(2)
        .max(20)
        .required(),

    name: Joi.string()
        .trim()
        .min(2)
        .max(150)
        .required(),

    department: Joi.string()
        .trim()
        .uppercase()
        .min(2)
        .max(50)
        .required(),

    semester: Joi.number()
        .integer()
        .min(1)
        .max(12)
        .required()
});

exports.createSection = Joi.object({
    courseId: Joi.string()
        .hex()
        .length(24)
        .required(),

    name: Joi.string()
        .trim()
        .uppercase()
        .min(1)
        .max(20)
        .required(),

    academicYear: Joi.string()
        .trim()
        .pattern(/^\d{4}-\d{4}$/)
        .required(),

    semester: Joi.number()
        .integer()
        .min(1)
        .max(12)
        .required(),

    roomCode: Joi.string()
        .trim()
        .uppercase()
        .min(1)
        .max(30)
        .required(),

    latitude: Joi.number()
        .min(-90)
        .max(90)
        .required(),

    longitude: Joi.number()
        .min(-180)
        .max(180)
        .required(),

    geofenceRadiusMeters: Joi.number()
        .integer()
        .min(5)
        .max(1000)
        .default(100),

    lecturers: Joi.array()
        .items(
            Joi.string()
                .hex()
                .length(24)
        )
        .default([])
});

exports.enrollStudent = Joi.object({
    studentId: Joi.string()
        .hex()
        .length(24)
        .required(),

    sectionId: Joi.string()
        .hex()
        .length(24)
        .required(),

    rollNumber: Joi.string()
        .trim()
        .uppercase()
        .min(1)
        .max(30)
        .required()
});