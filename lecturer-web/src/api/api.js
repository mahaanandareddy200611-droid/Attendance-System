import axios from "axios";
import { previewAdapter } from "./previewAdapter";
import { resolveApiBaseUrl } from "./apiOrigin.js";

const api = axios.create({
  baseURL: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, { dev: import.meta.env.DEV }),
  timeout: 15000,
  headers: {
    Accept: "application/json",
  },
});

// Attach the logged-in user's JWT to outgoing requests.
api.interceptors.request.use(
  (config) => {
    if (
      import.meta.env.DEV &&
      ["Admin", "Lecturer", "Student"].includes(
        sessionStorage.getItem("attendance:previewRole"),
      )
    ) {
      config.adapter = previewAdapter;
      return config;
    }

    const token =
      sessionStorage.getItem("token") || localStorage.getItem("token");

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

    const authMessage = String(error.response?.data?.error?.message || error.response?.data?.message || "");
    const isAuthenticationFailure =
      requestUrl.endsWith("/auth/me") ||
      /token not found|invalid authorization format|invalid or expired token\. please login again|invalid authentication token|session is no longer valid|session has expired or been revoked|please log in again|authentication required/i.test(authMessage);

    // A 401 may be an expired QR or biometric challenge. Do not end the user's
    // login session unless the response indicates an authentication failure.
    if (error.response?.status === 401 && !isPublicAuthRequest && isAuthenticationFailure) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      sessionStorage.removeItem("token");
      sessionStorage.removeItem("user");
      window.dispatchEvent(new Event("attendance:unauthorized"));
    }

    return Promise.reject(error);
  },
);

export default api;
