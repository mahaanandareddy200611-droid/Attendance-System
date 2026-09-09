
import { useState } from "react";
import { Link } from "react-router-dom";
import "./App.css";

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");

  const handleEmailChange = (e) => {
    setEmail(e.target.value);
  };

  const handleOtpChange = (e) => {
    setOtp(e.target.value);
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    console.log("Email:", email);
    console.log("OTP:", otp);
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Forgot Password?</h1>

        <p className="subtitle">
          Enter your email and the OTP sent to your email.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label>Email</label>

            <input
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={handleEmailChange}
              required
            />
          </div>

          <div className="input-group">
            <label>OTP</label>

            <input
              type="text"
              placeholder="Enter 6-digit OTP"
              value={otp}
              onChange={handleOtpChange}
              maxLength="6"
              required
            />
          </div>

          <button type="submit">Verify OTP</button>
        </form>

        <p className="bottom-text">
          Remember your password?{" "}
          <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}

export default ForgotPassword;

