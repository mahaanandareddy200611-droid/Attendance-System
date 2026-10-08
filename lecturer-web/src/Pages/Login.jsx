import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Login as loginUser } from "../services/auth.service";
import "./../Styles/App.css";

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      const response = await loginUser({
        email,
        password,
      });

      console.log("Login successful:", response);

      // Save JWT token
      localStorage.setItem("token", response.data.token);

      // Save user details
      localStorage.setItem(
        "user",
        JSON.stringify(response.data.data)
      );

      // Navigate to dashboard after successful login
      navigate("/dashboard");

    } catch (error) {
      console.error("Login failed:", error);

      alert(
        error.response?.data?.message ||
        "Invalid email or password"
      );
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Welcome Back</h1>

        <p className="subtitle">
          Login to your account
        </p>

        <form onSubmit={handleSubmit}>

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

          <div className="input-group">
            <label>Password</label>

            <input
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <p className="forgot-password">
            <Link to="/forgot-password">
              Forgot Password?
            </Link>
          </p>

          <button type="submit">
            Login
          </button>

        </form>

        <p className="bottom-text">
          Don't have an account?{" "}
          <Link to="/signup">
            Sign Up
          </Link>
        </p>
      </div>
    </div>
  );
}

export default Login;