import api from "../api/api";
export const getMyAttendanceRecords = (params = {}) => api.get("/attendance/records/me", { params });
export const getAvailableAttendanceSessions = () => api.get("/attendance/sessions/available");
export const validateAttendanceQr = (token) => api.post("/attendance/validate-qr", { token });

export async function markAttendance({ validationId, biometricAssertionId, idempotencyKey }) {
  if (!validationId) throw new Error("Scan and validate the lecturer's QR before face verification.");
  if (!biometricAssertionId) throw new Error("Complete the face match and liveness check before attendance is recorded.");
  return api.post("/attendance/verify", { validationId, biometricAssertionId }, {
    headers: { "Idempotency-Key": idempotencyKey || crypto.randomUUID() },
  });
}
