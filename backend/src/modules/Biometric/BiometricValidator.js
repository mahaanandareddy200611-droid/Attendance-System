const Joi = require("joi");

exports.challenge = Joi.object({
  sessionId: Joi.string().trim().min(8).max(200).required(),
});

exports.verify = Joi.object({
  sessionId: Joi.string().trim().min(8).max(200).required(),
  challengeId: Joi.string().uuid().required(),
  // A 32-byte base64url nonce encodes to exactly 43 characters.
  challenge: Joi.string().pattern(/^[A-Za-z0-9_-]{43}$/).required(),
});


// Used by POST /verify-active after the three frame fields have been parsed.
exports.activeVerify = Joi.object({
    sessionId: Joi.string().trim().min(8).max(200).required(),
    challengeId: Joi.string().uuid().required(),
    challenge: Joi.string().trim().min(32).max(128).pattern(/^[A-Za-z0-9_-]+$/).required()
});
