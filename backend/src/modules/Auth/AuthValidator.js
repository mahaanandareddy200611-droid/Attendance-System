const joi = require("joi");

exports.signup = joi.object({

    name: joi
        .string()
        .trim()
        .min(2)
        .max(100)
        .required(),

    RollNumber: joi
        .string()
        .pattern(/^\d{2}B[A-Z]{2}\d{3}$/)
        .trim()
        .required(),

    email: joi
        .string()
        .lowercase()
        .trim()
        .email()
        .required(),

    password: joi
        .string()
        .min(6)
        .required(),

    mobileNumber: joi
        .string()
        .pattern(/^[0-9]{10}$/)
        .required(),

    role: joi
        .string()
        .valid("Admin", "Lecturer", "Student")
        .default("Student"),

    faceImage_url: joi
        .string()
        .uri()
        .allow(null, "")
        .optional()

});


exports.login = joi.object({

    email: joi
        .string()
        .lowercase()
        .trim()
        .email()
        .required(),

    password: joi
        .string()
        .min(6)
        .required()

});


exports.forgotPassword = joi.object({

    email: joi
        .string()
        .lowercase()
        .email()
        .trim()
        .required()

});


exports.newpassword = joi.object({

    email: joi
        .string()
        .lowercase()
        .email()
        .trim()
        .required(),

    password: joi
        .string()
        .min(6)
        .required()

});


exports.otp = joi.object({

    email: joi
        .string()
        .lowercase()
        .email()
        .trim()
        .required(),

    otp: joi
        .string()
        .pattern(/^\d{6}$/)
        .required()

});