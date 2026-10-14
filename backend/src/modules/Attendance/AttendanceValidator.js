const Joi = require("joi");

exports.createSession = Joi.object({
  sectionId: Joi.string().hex().length(24).required(),
});

exports.verifyAttendance = Joi.object({
  token: Joi.string().min(20).max(4096).required(),
  deviceId: Joi.string().trim().min(8).max(200).required(),
  deviceSignature: Joi.string().min(40).max(256).required(),
  biometricAssertionId: Joi.string().uuid().required(),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  accuracyMeters: Joi.number().min(0).max(10000).required(),
  capturedAt: Joi.date().iso().required(),
});
