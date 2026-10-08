import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ForgotPassword,
  VerifyOtp,
  SetPassword,
} from "../services/auth.service";
import "./../Styles/App.css";

function ForgotPasswordPage() {
  const [step, setStep] = useState(1);

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const navigate = useNavigate();

  // STEP 1: Send OTP
  const handleSendOtp = async (e) => {
    e.preventDefault();

    try {
      const response = await ForgotPassword({
        email: email,
      });

      console.log("OTP sent:", response.data);

      alert(response.data.message);

      setStep(2);
    } catch (error) {
      console.error("Send OTP error:", error);

      alert(
        error.response?.data?.message ||
        "Failed to send OTP"
      );
    }
  };

  // STEP 2: Verify OTP
  const handleVerifyOtp = async (e) => {
    e.preventDefault();

    try {
      const response = await VerifyOtp({
        email: email,
        otp: otp,
      });

      console.log("OTP verified:", response.data);

      alert(response.data.message);

      setStep(3);
    } catch (error) {
      console.error("OTP verification error:", error);

      alert(
        error.response?.data?.message ||
        "Invalid OTP"
      );
    }
  };

  // STEP 3: Reset Password
  const handleResetPassword = async (e) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      alert("Passwords do not match");
      return;
    }

    try {
      const response = await SetPassword({
        email: email,
        password: password,
      });

      console.log("Password reset:", response.data);

      alert(response.data.message);

      // Password successfully changed
      // Navigate to Login page
      navigate("/login");

    } catch (error) {
      console.error("Reset password error:", error);

      alert(
        error.response?.data?.message ||
        "Failed to reset password"
      );
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">

        {/* STEP 1 - EMAIL */}
        {step === 1 && (
          <>
            <h1>Forgot Password?</h1>

            <p className="subtitle">
              Enter your email to receive an OTP.
            </p>

            <form onSubmit={handleSendOtp}>

              <div className="input-group">
                <label>Email</label>

                <input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <button type="submit">
                Send OTP
              </button>

            </form>
          </>
        )}

        {/* STEP 2 - OTP */}
        {step === 2 && (
          <>
            <h1>Verify OTP</h1>

            <p className="subtitle">
              Enter the OTP sent to your email.
            </p>

            <form onSubmit={handleVerifyOtp}>

              <div className="input-group">
                <label>Email</label>

                <input
                  type="email"
                  value={email}
                  disabled
                />
              </div>

              <div className="input-group">
                <label>OTP</label>

                <input
                  type="text"
                  placeholder="Enter 6-digit OTP"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  maxLength={6}
                  required
                />
              </div>

              <button type="submit">
                Verify OTP
              </button>

            </form>
          </>
        )}

        {/* STEP 3 - NEW PASSWORD */}
        {step === 3 && (
          <>
            <h1>Reset Password</h1>

            <p className="subtitle">
              Enter your new password.
            </p>

            <form onSubmit={handleResetPassword}>

              <div className="input-group">
                <label>New Password</label>

                <input
                  type="password"
                  placeholder="Enter new password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <div className="input-group">
                <label>Confirm New Password</label>

                <input
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) =>
                    setConfirmPassword(e.target.value)
                  }
                  required
                />
              </div>

              <button type="submit">
                Reset Password
              </button>

            </form>
          </>
        )}

        <p className="bottom-text">
          Remember your password?{" "}
          <Link to="/login">
            Login
          </Link>
        </p>

      </div>
    </div>
  );
}

export default ForgotPasswordPage;