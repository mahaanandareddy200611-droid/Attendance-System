import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GetCurrentUser,
  Login as loginRequest,
} from "../services/auth.service";
import { AuthContext } from "./AuthContext";

function clearStoredSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    clearStoredSession();
    setUser(null);
  }, []);

  useEffect(() => {
    let active = true;

    const restoreSession = async () => {
      if (!localStorage.getItem("token")) {
        setLoading(false);
        return;
      }

      try {
        const response = await GetCurrentUser();
        if (active) {
          setUser(response.data.data);
          localStorage.setItem("user", JSON.stringify(response.data.data));
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
  }, []);

  const login = useCallback(async (credentials) => {
    const response = await loginRequest(credentials);
    const { token, data: authenticatedUser } = response.data;

    if (!token || !authenticatedUser?.role) {
      throw new Error("The server returned an invalid login response.");
    }

    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(authenticatedUser));
    setUser(authenticatedUser);
    return authenticatedUser;
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
