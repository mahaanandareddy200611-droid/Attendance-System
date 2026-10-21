import axios from "axios";
import { previewAdapter } from "./previewAdapter";

function resolveApiBaseUrl() {
  const configured = String(import.meta.env.VITE_API_BASE_URL || "").trim();

  // Local development remains convenient, but production must never silently
  // ship a bundle that sends authenticated requests to the user's localhost.
  if (!configured) {
    if (import.meta.env.DEV) return "http://localhost:3000/api/v1";
    throw new Error("VITE_API_BASE_URL must be set to the deployed HTTPS API base ending in /api/v1.");
  }

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("VITE_API_BASE_URL must be a valid absolute URL.");
  }

  const localHttpAllowed =
    import.meta.env.DEV &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);

  if (
    (url.protocol !== "https:" && !localHttpAllowed) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== "/api/v1"
  ) {
    throw new Error("VITE_API_BASE_URL must use HTTPS and end exactly in /api/v1 (without credentials or query parameters).");
  }

  return url.origin + "/api/v1";
}

const api = axios.create({
  baseURL: resolveApiBaseUrl(),
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

    if (error.response?.status === 401 && !isPublicAuthRequest) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      sessionStorage.removeItem("token");

      window.dispatchEvent(new Event("attendance:unauthorized"));
    }

    return Promise.reject(error);
  },
);

export default api;
