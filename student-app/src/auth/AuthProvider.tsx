import * as SecureStore from "expo-secure-store";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { apiRequest } from "../lib/api";

type StudentUser = {
  id: string;
  email: string;
  name?: string;
  RollNumber?: string;
  role: string;
};

type AuthContextValue = {
  user: StudentUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const TOKEN_KEY = "attendance:student:access-token";
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<StudentUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const saved = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!saved) {
      setToken(null);
      setUser(null);
      return;
    }

    try {
      const response = await apiRequest<StudentUser>("/auth/me", { token: saved });
      const loadedUser = response.data;
      if (!loadedUser?.id || loadedUser.role !== "Student") {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        setToken(null);
        setUser(null);
        throw new Error("This mobile app is for student accounts. Sign in with a Student account.");
      }
      setToken(saved);
      setUser(loadedUser);
    } catch (error) {
      if ((error as { status?: number }).status === 401 ||
          (error as Error).message.includes("for student accounts")) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        setToken(null);
        setUser(null);
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await refreshUser();
      } catch {
        // An offline server shouldn't keep the login screen from being usable.
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [refreshUser]);

  const login = useCallback(async (email: string, password: string) => {
    const response = await apiRequest<StudentUser>("/auth/login", {
      method: "POST",
      body: { email: email.trim().toLowerCase(), password },
    });
    const nextToken = response.token;
    const nextUser = response.data;
    if (!nextToken || !nextUser?.id) throw new Error("Login response did not include a user and token.");
    if (nextUser.role !== "Student") throw new Error("This mobile app is for student accounts. Use a Student account.");
    await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const logout = useCallback(async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, token, loading, login, logout, refreshUser }),
    [user, token, loading, login, logout, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useStudentAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useStudentAuth must be used inside AuthProvider");
  return value;
}
