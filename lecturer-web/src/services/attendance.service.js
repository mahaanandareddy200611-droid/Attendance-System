import api from "../api/api";
import { signAttendanceRequest } from "./device.service";
import { verifyBiometricForSession } from "./biometric.service";

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

export async function markAttendance({ sessionId, token, verificationImage }) {
  const idempotencyKey = crypto.randomUUID();
  const [location, biometricAssertionId] = await Promise.all([
    getCurrentLocation(),
    verifyBiometricForSession({ sessionId, image: verificationImage }),
  ]);
  const deviceId = localStorage.getItem("attendanceDeviceId");
  if (!deviceId)
    throw new Error("Register this browser as your attendance device first.");
  const deviceSignature = await signAttendanceRequest({
    sessionId,
    token,
    idempotencyKey,
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
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
}
