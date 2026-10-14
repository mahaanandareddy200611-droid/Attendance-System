const jwt =
    require("jsonwebtoken");

const AppError =
    require("../utils/AppError");
const User = require("../models/Auth.model");

const Auth = async (req, res, next) => {

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

    let verifiedToken;
    try {
        verifiedToken = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return next(
            new AppError(
                "Invalid or expired token. Please login again.",
                401
            )
        );
    }

    const userId = verifiedToken.id || verifiedToken.sub;
    if (!userId) {
        return next(new AppError("Invalid authentication token.", 401));
    }

    try {
        // Read current role/status from MongoDB so old JWT claims cannot retain access.
        const user = await User.findById(userId).select("role status").lean();
        if (!user) {
            return next(new AppError("Session is no longer valid. Please log in again.", 401));
        }
        if (user.status !== "ACTIVE") {
            return next(new AppError("This account is not active.", 403));
        }

        req.user = {
            ...verifiedToken,
            id: String(user._id),
            role: user.role,
        };
        return next();
    } catch (error) {
        return next(error);
    }
};

module.exports = Auth;
