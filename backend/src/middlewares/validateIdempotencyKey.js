'use strict';

const AppError = require("../utils/AppError");

// Keys are opaque request identifiers, not arbitrary user content. Restrict
// length and alphabet before writing them to MongoDB and Redis-backed flows.
module.exports = function validateIdempotencyKey(req, res, next) {
  const key = req.get("Idempotency-Key");

  if (
    typeof key !== "string" ||
    key.length < 16 ||
    key.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  ) {
    return next(
      new AppError(
        "Idempotency-Key must contain 16-128 safe characters",
        400
      )
    );
  }

  req.idempotencyKey = key;
  return next();
};
