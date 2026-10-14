import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GetCurrentUser,
  Login as loginRequest,
} from "../services/auth.service";
import { previewUser } from "../api/previewAdapter";
import { AuthContext } from "./AuthContext";

function clearStoredSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("user");
  sessionStorage.removeItem("attendance:previewRole");
}

export function AuthProvider({ children }) {
  const [previewMode] = useState(() => {
    const requestedRole = new URLSearchParams(window.location.search).get(
      "preview",
    );
    const role =
      requestedRole || sessionStorage.getItem("attendance:previewRole");
    const preview = previewUser(role);

    if (preview && requestedRole) {
      sessionStorage.setItem("attendance:previewRole", requestedRole);
    }

    return preview;
  });
  const [user, setUser] = useState(previewMode);
  const [loading, setLoading] = useState(!previewMode);

  const logout = useCallback(() => {
    clearStoredSession();
    setUser(null);
  }, []);

  useEffect(() => {
    if (previewMode) return undefined;
    let active = true;

    const restoreSession = async () => {
      const legacyToken = localStorage.getItem("token");
      if (legacyToken && !sessionStorage.getItem("token")) {
        sessionStorage.setItem("token", legacyToken);
        localStorage.removeItem("token");
        localStorage.removeItem("user");
      }
      if (!sessionStorage.getItem("token")) {
        setLoading(false);
        return;
      }

      try {
        const response = await GetCurrentUser();
        if (active) {
          setUser(response.data.data);
          sessionStorage.setItem("user", JSON.stringify(response.data.data));
        }
      } catch {
        clearStoredSession();
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    const onUnauthorized = () => {
      if (active) setUser(null);
    };

    window.addEventListener("attendance:unauthorized", onUnauthorized);
    restoreSession();

    return () => {
      active = false;
      window.removeEventListener("attendance:unauthorized", onUnauthorized);
    };
  }, [previewMode]);

  const login = useCallback(async (credentials) => {
    const response = await loginRequest(credentials);
    const { token, data: authenticatedUser } = response.data;

    if (!token || !authenticatedUser?.role) {
      throw new Error("The server returned an invalid login response.");
    }

    sessionStorage.setItem("token", token);
    sessionStorage.setItem("user", JSON.stringify(authenticatedUser));
    setUser(authenticatedUser);
    return authenticatedUser;
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
