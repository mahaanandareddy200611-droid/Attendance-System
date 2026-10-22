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

// Handle expired or rejected authentication on protected requests.
api.interceptors.response.use(
  (response) => response,

  (error) => {
    const requestUrl = String(error.config?.url || "");

    // Only /auth/me is the canonical session validation endpoint. A 401 from
    // QR preflight, biometric verification, or GPS check is an operation error,
    // not proof that the user's login has expired. Do not unmount the workspace
    // when those domain checks reject an otherwise authenticated request.
    const isSessionValidation = requestUrl.split("?")[0].endsWith("/auth/me");

    if (error.response?.status === 401 && isSessionValidation) {
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
