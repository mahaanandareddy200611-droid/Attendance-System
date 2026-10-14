import api from "../api/api";

export const Signup = (data) => api.post("/auth/signup", data);
export const Login = (data) => api.post("/auth/login", data);
export const GetCurrentUser = () => api.get("/auth/me");
export const ForgotPassword = (data) => api.post("/auth/forget-password", data);
export const VerifyOtp = (data) => api.post("/auth/verify-reset-otp", data);
export const SetPassword = (data) => api.post("/auth/reset-password", data);
