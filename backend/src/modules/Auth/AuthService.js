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
  faceImage_url,
  mobileNumber,
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
    // Public registration is student-only. Privileged accounts are provisioned separately.
    role: "Student",
  });

  return user;
};

exports.Login = async (email, password) => {
  const user = await User.findOne({ email }).select("+password");

  if (!user) {
    throw new AppError("Invalid email or password", 401);
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    throw new AppError("Invalid email or password", 401);
  }

  if (user.status !== "ACTIVE") {
    throw new AppError("This account is not active.", 403);
  }

  const token = jwt.sign(
    {
        id: user._id,
        role: user.role,
        tokenVersion: Number.isInteger(user.tokenVersion)
            ? user.tokenVersion
            : 0
    },
    process.env.JWT_SECRET,
    {
        expiresIn: process.env.JWT_EXPIRES_IN || "1d"
    }
);

  return {
    user,
    token,
  };
};

exports.forgotPassword = async (email) => {
  const user = await User.findOne({ email });

  if (!user) {
    // The controller returns the same public response whether
    // or not this email belongs to an account.
    return { sent: true };
}

  const otp = crypto.randomInt(100000, 1000000).toString();

  const otpHash = crypto.createHash("sha256").update(otp).digest("hex");

  user.passwordResetOtpHash = otpHash;

  user.passwordResetOtpExpires = new Date(Date.now() + 5 * 60 * 1000);

  user.passwordResetOtpAttempts = 0;

  user.passwordResetVerifiedUntil = null;
  user.passwordResetTokenHash = null;
  user.passwordResetTokenExpires = null;

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
        `,
  });

  return {
    sent: true,
  };
};

exports.verifyResetOTP = async (otp, email) => {
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!/^\d{6}$/.test(String(otp || "")) || !normalizedEmail) {
        throw new AppError("Invalid or expired OTP", 400);
    }

    const now = new Date();
    const user = await User.findOne({ email: normalizedEmail }).select(
        "+passwordResetOtpHash +passwordResetOtpExpires +passwordResetOtpAttempts"
    );

    if (
        !user ||
        !user.passwordResetOtpHash ||
        !user.passwordResetOtpExpires ||
        user.passwordResetOtpExpires.getTime() <= now.getTime()
    ) {
        throw new AppError("Invalid or expired OTP", 400);
    }

    if (user.passwordResetOtpAttempts >= 5) {
        throw new AppError("Too many incorrect OTP attempts", 429);
    }

    const suppliedHash = crypto.createHash("sha256").update(String(otp)).digest();
    const storedHash = Buffer.from(user.passwordResetOtpHash, "hex");
    const matches =
        storedHash.length === suppliedHash.length &&
        crypto.timingSafeEqual(storedHash, suppliedHash);

    if (!matches) {
        const attemptUpdate = await User.updateOne(
            {
                _id: user._id,
                passwordResetOtpHash: user.passwordResetOtpHash,
                passwordResetOtpExpires: { $gt: now },
                passwordResetOtpAttempts: { $lt: 5 }
            },
            { $inc: { passwordResetOtpAttempts: 1 } }
        );

        if (attemptUpdate.matchedCount !== 1) {
            throw new AppError("Invalid or expired OTP", 400);
        }
        throw new AppError("Incorrect OTP", 400);
    }

    // Return a high-entropy one-time token to the client; only its hash is stored.
    // The OTP is consumed in the same conditional write so concurrent verifications
    // cannot mint multiple valid reset tokens from one code.
    const resetToken = crypto.randomBytes(32).toString("base64url");
    const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
    const resetTokenExpires = new Date(now.getTime() + 10 * 60 * 1000);

    const verificationUpdate = await User.updateOne(
        {
            _id: user._id,
            passwordResetOtpHash: user.passwordResetOtpHash,
            passwordResetOtpExpires: { $gt: now },
            passwordResetOtpAttempts: { $lt: 5 }
        },
        {
            $set: {
                passwordResetTokenHash: resetTokenHash,
                passwordResetTokenExpires: resetTokenExpires,
                passwordResetVerifiedUntil: null,
                passwordResetOtpHash: null,
                passwordResetOtpExpires: null,
                passwordResetOtpAttempts: 0
            }
        }
    );

    if (verificationUpdate.matchedCount !== 1) {
        throw new AppError("Invalid or expired OTP", 400);
    }

    return { verified: true, resetToken };
};

exports.password = async (password, email, resetToken) => {
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (
        typeof password !== "string" ||
        !password ||
        !normalizedEmail ||
        typeof resetToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(resetToken)
    ) {
        throw new AppError("Password-reset authorization is invalid or expired", 400);
    }

    const now = new Date();
    const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
    const hashedPassword = await bcrypt.hash(password, 12);

    // The hash, expiry and account are bound into one atomic conditional update.
    // Clearing the token in the same write makes it single-use under concurrent retries.
    const result = await User.updateOne(
        {
            email: normalizedEmail,
            passwordResetTokenHash: resetTokenHash,
            passwordResetTokenExpires: { $gt: now }
        },
        {
            $set: {
                password: hashedPassword,
                passwordResetTokenHash: null,
                passwordResetTokenExpires: null,
                passwordResetVerifiedUntil: null,
                passwordResetOtpHash: null,
                passwordResetOtpExpires: null,
                passwordResetOtpAttempts: 0
            },
            $inc: { tokenVersion: 1 }
        }
    );

    if (result.matchedCount !== 1) {
        throw new AppError("Password-reset authorization is invalid or expired", 400);
    }

    return { updated: true };
};

exports.Logout = async (userId) => {
    if (!userId) {
        throw new AppError("Authentication required", 401);
    }

    const result = await User.updateOne(
        { _id: userId, status: "ACTIVE" },
        { $inc: { tokenVersion: 1 } }
    );

    if (result.matchedCount !== 1) {
        throw new AppError("Session is no longer valid. Please log in again.", 401);
    }

    // tokenVersion is account-scoped, so all existing JWTs are revoked.
    return { revoked: true };
};

exports.GetCurrentUser = async (userId) => {
  if (!userId) {
    throw new AppError("Authentication required", 401);
  }

  const user = await User.findById(userId);

  if (!user) {
    throw new AppError("Session is no longer valid. Please login again.", 401);
  }

  if (user.status && user.status !== "ACTIVE") {
    throw new AppError("This account is not active.", 403);
  }

  return user;
};

exports.CreateLecturer = async ({ name, email, password, mobileNumber }) => {
    const existing = await User.findOne({ email });
    if (existing) throw new AppError("Email already registered", 409);

    const passwordHash = await bcrypt.hash(password, 12);
    try {
        return await User.create({
            Name: name,
            email,
            password: passwordHash,
            mobileNumber,
            role: "Lecturer",
            status: "ACTIVE"
        });
    } catch (error) {
        if (error.code === 11000) throw new AppError("Email already registered", 409);
        throw error;
    }
};
