import * as Location from "expo-location";
import * as Crypto from "expo-crypto";

import { apiRequest } from "./api";
import { getOrRegisterNativeDevice, signAttendance } from "./device";

export async function getAvailableSessions(token: string) {
  const response = await apiRequest<any>("/attendance/sessions/available", { token });
  return Array.isArray(response.data) ? response.data : [];
}

export async function getMyAttendance(token: string) {
  const response = await apiRequest<any>("/attendance/records/me?limit=50", { token });
  return Array.isArray(response.data) ? response.data : [];
}

export async function captureLocationEvidence() {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== "granted") {
    throw new Error("Allow location access before marking attendance.");
  }
  const result = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
    mayShowUserSettingsDialog: true,
  });
  return {
    latitude: result.coords.latitude,
    longitude: result.coords.longitude,
    accuracyMeters: result.coords.accuracy ?? 9999,
    capturedAt: new Date(result.timestamp).toISOString(),
  };
}

export async function submitAttendance({
  userId,
  token,
  sessionId,
  qrToken,
  biometricAssertionId,
  location,
}: {
  userId: string;
  token: string;
  sessionId: string;
  qrToken: string;
  biometricAssertionId: string;
  location: { latitude: number; longitude: number; accuracyMeters: number; capturedAt: string };
}) {
  const deviceId = await getOrRegisterNativeDevice(userId, token);
  const idempotencyKey = Crypto.randomUUID();
  const deviceSignature = await signAttendance({
    userId,
    deviceId,
    sessionId,
    qrToken,
    idempotencyKey,
    biometricAssertionId,
    ...location,
  });
  return apiRequest<any>("/attendance/verify", {
    method: "POST",
    token,
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      token: qrToken,
      deviceId,
      deviceSignature,
      biometricAssertionId,
      ...location,
    },
    timeoutMs: 20000,
  });
}
