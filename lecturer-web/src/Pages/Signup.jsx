import { Signup as signupuser, Login as loginuser } from "../services/auth.service";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getApiErrorMessage } from "../api/errors";
import "./../Styles/App.css";

function Signup() {
  const [name, setName] = useState("");
  const [rollNumber, setRollNumber] = useState("");
  const [email, setEmail] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [faceConsent, setFaceConsent] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage("");

    if (!faceConsent) {
      setErrorMessage("Please read and accept the face-enrollment notice to create a student attendance account.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const data = {
        name: name.trim(),
        RollNumber: rollNumber.trim().toUpperCase(),
        email: email.trim().toLowerCase(),
        password,
        faceImage_url: "",
        mobileNumber: mobileNumber.replace(/\s+/g, ""),
      };

      await signupuser(data);

      // Continue directly into the required enrollment step. A full-page
      // navigation lets AuthProvider restore the freshly issued session token.
      try {
        const loginResponse = await loginuser({ email: data.email, password });
        const token = loginResponse?.data?.token;
        const signedInUser = loginResponse?.data?.data;
        if (!token || signedInUser?.role !== "Student") {
          throw new Error("The new student session could not be started.");
        }
        sessionStorage.setItem("token", token);
        sessionStorage.setItem("user", JSON.stringify(signedInUser));
        window.location.replace("/student/face-enrollment?required=1&consent=face-attendance-v1");
        return;
      } catch {
        navigate("/login", {
          replace: true,
          state: {
            notice: "Your account was created. Sign in to finish the required face enrollment before attendance is enabled.",
          },
        });
      }
    } catch (error) {
      setErrorMessage(
        getApiErrorMessage(
          error,
          "Signup failed. Please check the information.",
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
        <h1>Create your account</h1>

        <p className="subtitle">Create a student account to get started</p>

        {errorMessage && (
          <p className="form-message error" role="alert">
            {errorMessage}
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label htmlFor="signup-name">Name</label>

            <input
              id="signup-name"
              type="text"
              autoComplete="name"
              placeholder="Enter your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <label htmlFor="signup-roll">Roll number</label>

            <input
              id="signup-roll"
              type="text"
              autoComplete="off"
              placeholder="24BCS101"
              pattern="[0-9]{2}B[A-Z]{2}[0-9]{3}"
              value={rollNumber}
              onChange={(e) => setRollNumber(e.target.value.toUpperCase())}
              required
            />
          </div>

          <div className="input-group">
            <label htmlFor="signup-email">Email</label>

            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <label htmlFor="signup-mobile">Mobile number</label>

            <input
              id="signup-mobile"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              pattern="[0-9]{10}"
              maxLength={10}
              placeholder="10-digit mobile number"
              value={mobileNumber}
              onChange={(e) => setMobileNumber(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <label htmlFor="signup-password">Password</label>

            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              placeholder="Create a password"
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <label htmlFor="signup-confirm">Confirm password</label>

            <input
              id="signup-confirm"
              type="password"
              autoComplete="new-password"
              placeholder="Confirm your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          <label className="consent-check">
            <input
              type="checkbox"
              checked={faceConsent}
              onChange={(event) => setFaceConsent(event.target.checked)}
              required
            />
            <span>
              <strong>Required face-enrollment consent.</strong> After account creation, the app will open the front camera and automatically capture one enrollment image once the live preview is ready. The camera will be visibly active. The attendance database stores a provider profile reference and consent record, not the raw image or face vector; the configured biometric provider manages the face profile.
            </span>
          </label>

          <button type="submit" disabled={submitting || !faceConsent}>
            {submitting ? "Creating account…" : "Sign Up"}
          </button>
        </form>

        <p className="bottom-text">
          Already have an account? <Link to="/login">Login</Link>
        </p>
      </section>
    </div>
  );
}

export default Signup;
