const AppError = require("../utils/AppError");

const authorize = (...allowedRoles) => {
    return (req, res, next) => {

        if (!req.user) {
            return next(
                new AppError("Authentication required", 401)
            );
        }

        if (!allowedRoles.includes(req.user.role)) {
            return next(
                new AppError("You are not authorized for this action", 403)
            );
        }

        next();
    };
};

module.exports = authorize;