const Joi = require("joi");

exports.registerDevice = Joi.object({
  challengeId: Joi.string().uuid().required(),
  deviceId: Joi.string().trim().min(8).max(200).required(),
  publicKey: Joi.string().min(60).max(1000).required(),
  signature: Joi.string().min(40).max(256).required(),
});
