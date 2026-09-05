const User = require("../../models/Auth.model");
const AppError = require("../../utils/AppError");

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const { sendMail } = require("../../utils/sendMail");


exports.Signup = async (
    name,
    RollNumber,
    email,
    password,
    role,
    faceImage_url,
    mobileNumber
) => {

    const existingEmail = await User.findOne({ email });

    if (existingEmail) {
        throw new AppError("Email already registered", 409);
    }

    if (RollNumber) {
        const existingRoll = await User.findOne({ RollNumber });

        if (existingRoll) {
            throw new AppError("Roll number already registered", 409);
        }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
        Name: name,
        RollNumber,
        email,
        password: passwordHash,
        mobileNumber,
        faceImage_url,
        role: role || "Student"
    });

    return user;
};


exports.Login = async (email, password) => {

    const user = await User
        .findOne({ email })
        .select("+password");

    if (!user) {
        throw new AppError("Invalid email or password", 401);
    }

    const isPasswordValid = await bcrypt.compare(
        password,
        user.password
    );

    if (!isPasswordValid) {
        throw new AppError("Invalid email or password", 401);
    }

    const token = jwt.sign(
        {
            id: user._id,
            role: user.role
        },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || "1d"
        }
    );

    return {
        user,
        token
    };
};


exports.forgotPassword = async (email) => {

    const user = await User.findOne({ email });

    if (!user) {
        throw new AppError("Email not found", 404);
    }

    const otp = crypto
        .randomInt(100000, 1000000)
        .toString();

    const otpHash = crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");

    user.passwordResetOtpHash = otpHash;

    user.passwordResetOtpExpires =
        new Date(Date.now() + 5 * 60 * 1000);

    user.passwordResetOtpAttempts = 0;

    user.passwordResetVerifiedUntil = null;

    await user.save();

    await sendMail({
        to: email,
        subject: "Attendence System Password Reset OTP",

        text: `Your Attendence System reset OTP is ${otp}. It is valid for 5 minutes.`,

        html: `
            <h2>Attendence System Password Reset</h2>

            <p>Your password reset OTP is:</p>

            <h1>${otp}</h1>

            <p>
                This OTP is valid for <strong>5 minutes</strong>.
            </p>

            <p>
                If you did not request this password reset,
                please ignore this email.
            </p>
        `
    });

    console.log("PASSWORD RESET OTP:", otp);

    return {
        sent: true
    };
};


exports.verifyResetOTP = async (otp, email) => {

    if (!otp) {
        throw new AppError("OTP is required", 400);
    }

    if (!email) {
        throw new AppError("Email is required", 400);
    }

    const user = await User
        .findOne({ email })
        .select(
            "+passwordResetOtpHash " +
            "+passwordResetOtpExpires " +
            "+passwordResetOtpAttempts"
        );

    if (!user) {
        throw new AppError("Email not found", 404);
    }

    if (!user.passwordResetOtpHash) {
        throw new AppError("No OTP request found", 400);
    }

    if (user.passwordResetOtpAttempts >= 5) {
        throw new AppError(
            "Too many incorrect OTP attempts",
            429
        );
    }

    if (
        !user.passwordResetOtpExpires ||
        user.passwordResetOtpExpires.getTime() <= Date.now()
    ) {
        throw new AppError("OTP expired", 400);
    }

    const otpHash = crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");

    const isMatch =
        otpHash === user.passwordResetOtpHash;

    if (!isMatch) {

        user.passwordResetOtpAttempts += 1;

        await user.save();

        throw new AppError("Incorrect OTP", 400);
    }

    user.passwordResetVerifiedUntil =
        new Date(Date.now() + 10 * 60 * 1000);

    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpires = null;
    user.passwordResetOtpAttempts = 0;

    await user.save();

    return {
        verified: true
    };
};


exports.password = async (password, email) => {

    if (!password) {
        throw new AppError("Password is required", 400);
    }

    if (!email) {
        throw new AppError("Email is required", 400);
    }

    const user = await User
        .findOne({ email })
        .select("+passwordResetVerifiedUntil");

    if (!user) {
        throw new AppError("Email not found", 404);
    }

    if (
        !user.passwordResetVerifiedUntil ||
        user.passwordResetVerifiedUntil.getTime() <= Date.now()
    ) {
        throw new AppError(
            "OTP verification required or expired",
            400
        );
    }

    const hashedPassword =
        await bcrypt.hash(password, 12);

    user.password = hashedPassword;

    user.passwordResetVerifiedUntil = null;

    await user.save();

    return {
        updated: true
    };
};