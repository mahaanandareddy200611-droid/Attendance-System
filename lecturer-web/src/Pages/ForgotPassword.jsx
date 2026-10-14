import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ForgotPassword,
  SetPassword,
  VerifyOtp,
} from "../services/auth.service";
import { getApiErrorMessage } from "../api/errors";
import "../Styles/App.css";

export default function ForgotPasswordPage() {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (event, action, successMessage, nextStep) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await action();
      if (nextStep) setStep(nextStep);
      if (successMessage) setMessage(successMessage);
      if (nextStep === 0) navigate("/login", { replace: true });
    } catch (requestError) {
      setError(
        getApiErrorMessage(
          requestError,
          "Password recovery could not be completed.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleReset = (event) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    submit(
      event,
      () => SetPassword({ email, password }),
      "Your password has been reset.",
      0,
    );
  };

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="recovery-title">
        <Link className="auth-brand" to="/login">
          <span className="auth-logo">A</span>Attendance
        </Link>
        <h1 id="recovery-title">
          {step === 1
            ? "Reset your password"
            : step === 2
              ? "Verify your email"
              : "Choose a new password"}
        </h1>
        <p className="subtitle">
          {step === 1 &&
            "Enter your account email and we’ll send a one-time code."}
          {step === 2 && `Enter the one-time code sent to ${email}.`}
          {step === 3 && "Choose a password you have not used before."}
        </p>
        {error && (
          <p className="form-message error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="form-message success" role="status">
            {message}
          </p>
        )}

        {step === 1 && (
          <form
            onSubmit={(event) =>
              submit(
                event,
                () => ForgotPassword({ email }),
                "If this email belongs to an account, a code has been sent.",
                2,
              )
            }
          >
            <div className="input-group">
              <label htmlFor="recovery-email">Email</label>
              <input
                id="recovery-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send one-time code"}
            </button>
          </form>
        )}

        {step === 2 && (
          <form
            onSubmit={(event) =>
              submit(
                event,
                () => VerifyOtp({ email, otp }),
                "Email verified. Set a new password.",
                3,
              )
            }
          >
            <div className="input-group">
              <label htmlFor="recovery-otp">One-time code</label>
              <input
                id="recovery-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={otp}
                onChange={(event) =>
                  setOtp(event.target.value.replace(/\D/g, ""))
                }
                required
              />
            </div>
            <button type="submit" disabled={busy || otp.length !== 6}>
              {busy ? "Checking…" : "Verify code"}
            </button>
          </form>
        )}

        {step === 3 && (
          <form onSubmit={handleReset}>
            <div className="input-group">
              <label htmlFor="new-password">New password</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                minLength={10}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <div className="input-group">
              <label htmlFor="confirm-password">Confirm new password</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                minLength={10}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </div>
            <button type="submit" disabled={busy}>
              {busy ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}

        <p className="bottom-text">
          Remembered your password? <Link to="/login">Back to login</Link>
        </p>
      </section>
    </main>
  );
}
