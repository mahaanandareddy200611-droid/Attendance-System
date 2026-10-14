const Joi = require("joi");

exports.challenge = Joi.object({
  sessionId: Joi.string().trim().min(8).max(200).required(),
});

exports.verify = Joi.object({
  sessionId: Joi.string().trim().min(8).max(200).required(),
  challengeId: Joi.string().uuid().required(),
});
