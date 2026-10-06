const jwt =
    require("jsonwebtoken");

const AppError =
    require("../utils/AppError");

const Auth = (req, res, next) => {

    const authHeader =
        req.headers.authorization;

    if (!authHeader) {
        return next(
            new AppError(
                "Token not found. Please login again.",
                401
            )
        );
    }

    if (
        !authHeader.startsWith("Bearer ")
    ) {
        return next(
            new AppError(
                "Invalid authorization format.",
                401
            )
        );
    }

    const token =
        authHeader.slice(7).trim();

    if (!token) {
        return next(
            new AppError(
                "Token not found. Please login again.",
                401
            )
        );
    }

    try {

        const verifiedToken =
            jwt.verify(
                token,
                process.env.JWT_SECRET
            );

        req.user = verifiedToken;

        next();

    } catch (error) {

        return next(
            new AppError(
                "Invalid or expired token. Please login again.",
                401
            )
        );
    }
};

module.exports = Auth;