import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:3000/api/v1",

  timeout: 15000,

  headers: {
    Accept: "application/json",
  },
});

// Attach the logged-in user's JWT to outgoing requests.
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("token");

    if (token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
  (error) => Promise.reject(error),
);

// These endpoints are accessible without an active login.
const publicAuthPaths = [
  "/auth/login",
  "/auth/signup",
  "/auth/forget-password",
  "/auth/verify-reset-otp",
  "/auth/reset-password",
];

// Handle expired or rejected authentication on protected requests.
api.interceptors.response.use(
  (response) => response,

  (error) => {
    const requestUrl = String(error.config?.url || "");

    const isPublicAuthRequest = publicAuthPaths.some((path) =>
      requestUrl.endsWith(path),
    );

    if (error.response?.status === 401 && !isPublicAuthRequest) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");

      window.dispatchEvent(new Event("attendance:unauthorized"));
    }

    return Promise.reject(error);
  },
);

export default api;
