import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { safeReturnPath } from "../utils/navigation.js";
import { getApiErrorMessage } from "../api/errors";
import "./../Styles/App.css";

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage("");
    setSubmitting(true);

    try {
      const user = await login({ email, password });
      const defaultPath = {
        Admin: "/admin/dashboard",
        Lecturer: "/lecturer/dashboard",
        Student: "/student/dashboard",
      }[user.role];

      if (!defaultPath)
        throw new Error("Your account has an unsupported role.");
      navigate(safeReturnPath(location.state?.from, defaultPath), {
        replace: true,
      });
    } catch (error) {
      setErrorMessage(
        getApiErrorMessage(
          error,
          "Login failed. Check your email and password.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <section className="auth-card">
        <Link className="auth-brand" to="/login">
          <span className="auth-logo">A</span>Attendance
        </Link>
        <h1>Welcome back</h1>

        <p className="subtitle">Login to your account</p>

        {location.state?.notice && (
          <p className="form-message success" role="status">
            {location.state.notice}
          </p>
        )}
        {errorMessage && (
          <p className="form-message error" role="alert">
            {errorMessage}
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label htmlFor="login-email">Email</label>

            <input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <label htmlFor="login-password">Password</label>

            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <p className="forgot-password">
            <Link to="/forgot-password">Forgot Password?</Link>
          </p>

          <button type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Login"}
          </button>
        </form>

        <p className="bottom-text">
          Don't have an account? <Link to="/signup">Sign Up</Link>
        </p>
      </section>
    </div>
  );
}

export default Login;
