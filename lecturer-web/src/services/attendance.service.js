import api from "../api/api";
import { signAttendanceRequest } from "./device.service";
import { verifyBiometricForSession } from "./biometric.service";

export const getMyAttendanceRecords = (params = {}) =>
  api.get("/attendance/records/me", { params });
export const getAvailableAttendanceSessions = () =>
  api.get("/attendance/sessions/available");

function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error("Location is not supported by this browser."));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        resolve({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracyMeters: coords.accuracy,
          capturedAt: new Date().toISOString(),
        }),
      (error) =>
        reject(
          new Error(
            error.message || "Allow location access to mark attendance.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

export async function markAttendance({
  userId,
  sessionId,
  token,
  verificationImage,
  idempotencyKey,
}) {
  const requestKey = idempotencyKey || crypto.randomUUID();
  const [location, biometricAssertionId] = await Promise.all([
    getCurrentLocation(),
    verifyBiometricForSession({ sessionId, image: verificationImage }),
  ]);
  const deviceId = localStorage.getItem(`attendanceDeviceId:${userId}`);
  if (!deviceId)
    throw new Error("Register this browser as your attendance device first.");
  const deviceSignature = await signAttendanceRequest({
    userId,
    sessionId,
    token,
    idempotencyKey: requestKey,
  });
  return api.post(
    "/attendance/verify",
    {
      token,
      deviceId,
      deviceSignature,
      biometricAssertionId,
      ...location,
    },
    { headers: { "Idempotency-Key": requestKey } },
  );
}
