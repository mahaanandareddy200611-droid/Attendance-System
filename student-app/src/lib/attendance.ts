import * as Location from "expo-location";

import { apiRequest } from "./api";
import { signAttendance } from "./device";

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
  deviceId,
  sessionId,
  qrToken,
  idempotencyKey,
  biometricAssertionId,
  location,
}: {
  userId: string;
  token: string;
  deviceId: string;
  sessionId: string;
  qrToken: string;
  idempotencyKey: string;
  biometricAssertionId: string;
  location: { latitude: number; longitude: number; accuracyMeters: number; capturedAt: string };
}) {
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

export async function validateAttendanceQr(token: string, qrToken: string) {
  const response = await apiRequest<any>("/attendance/validate-qr", {
    method: "POST",
    token,
    body: { token: qrToken },
    timeoutMs: 90000,
  });
  const ticket = response.data;
  if (!ticket?.validationId || !ticket?.sessionId) {
    throw new Error("The server did not return a valid QR-check ticket. Scan the current lecturer QR again.");
  }
  return ticket as {
    validationId: string;
    sessionId: string;
    courseCode?: string;
    section?: string;
    expiresInMs?: number;
  };
}

export async function submitValidatedAttendance({
  token,
  validationId,
  biometricAssertionId,
  idempotencyKey,
}: {
  token: string;
  validationId: string;
  biometricAssertionId: string;
  idempotencyKey: string;
}) {
  if (!validationId || !biometricAssertionId) {
    throw new Error("A server-validated QR and a passed face/liveness assertion are required.");
  }
  return apiRequest<any>("/attendance/verify", {
    method: "POST",
    token,
    headers: { "Idempotency-Key": idempotencyKey },
    body: { validationId, biometricAssertionId },
    timeoutMs: 20000,
  });
}
