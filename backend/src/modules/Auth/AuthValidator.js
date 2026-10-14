const joi = require("joi");

// Public signup must not allow users to choose privileged roles.
// Admin and Lecturer accounts should be created through an authorized process.
exports.signup = joi.object({
  name: joi.string().trim().min(2).max(100).required(),

  RollNumber: joi
    .string()
    .trim()
    .pattern(/^\d{2}B[A-Z]{2}\d{3}$/)
    .required(),

  email: joi.string().lowercase().trim().email().required(),

  password: joi.string().min(6).required(),

  mobileNumber: joi
    .string()
    .pattern(/^[0-9]{10}$/)
    .required(),

  faceImage_url: joi.string().uri().allow(null, "").optional(),
});

exports.createLecturer = joi.object({
  name: joi.string().trim().min(2).max(100).required(),
  email: joi.string().lowercase().trim().email().required(),
  password: joi.string().min(10).required(),
  mobileNumber: joi.string().pattern(/^[0-9]{10}$/).required(),
});

exports.login = joi.object({
  email: joi.string().lowercase().trim().email().required(),
  password: joi.string().min(6).required(),
});

exports.forgotPassword = joi.object({
  email: joi.string().lowercase().email().trim().required(),
});

exports.newpassword = joi.object({
  email: joi.string().lowercase().email().trim().required(),
  password: joi.string().min(6).required(),
});

exports.otp = joi.object({
  email: joi.string().lowercase().email().trim().required(),
  otp: joi
    .string()
    .pattern(/^\d{6}$/)
    .required(),
});
