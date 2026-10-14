const AppError = require("./AppError");

const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      const messages = error.details.map((detail) => detail.message);

      return next(new AppError(messages.join(", "), 400));
    }

    // Pass only the validated and sanitized data to the controller.
    req.body = value;

    return next();
  };
};

module.exports = validate;
