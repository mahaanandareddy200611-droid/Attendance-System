import api from "../api/api";

export const getMyAttendanceRecords = (params = {}) =>
  api.get("/attendance/records/me", { params });
export const getAvailableAttendanceSessions = () =>
  api.get("/attendance/sessions/available");

// The server validates the signed rotating QR while it is fresh and returns
// a short-lived intent bound to this authenticated student. Face/liveness may
// finish after the visible QR has rotated; the final API checks the intent.
export async function prepareAttendanceCheckin(token, sessionId) {
  if (typeof token !== "string" || token.trim().length < 20) {
    throw new Error("Scan a valid attendance QR first.");
  }
  const response = await api.post("/attendance/preflight", { token: token.trim(), sessionId });
  return response.data.data;
}

export function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not supported by this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracyMeters: coords.accuracy,
        capturedAt: new Date().toISOString(),
      }),
      (error) => reject(new Error(error.message || "Allow location access to mark attendance.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

export async function markAttendance({
  checkinIntentId,
  biometricAssertionId,
  locationEvidence,
  idempotencyKey,
}) {
  if (!checkinIntentId) {
    throw new Error("Scan and validate the lecturer's QR before checking in.");
  }
  if (!biometricAssertionId) {
    throw new Error("Complete the face and liveness check before marking attendance.");
  }

  const location = locationEvidence || await getCurrentLocation();
  const requestKey = idempotencyKey || crypto.randomUUID();
  return api.post(
    "/attendance/verify",
    {
      checkinIntentId,
      biometricAssertionId,
      ...location,
    },
    { headers: { "Idempotency-Key": requestKey } },
  );
}
