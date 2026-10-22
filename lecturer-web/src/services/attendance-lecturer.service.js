import api from "../api/api";

export const startAttendanceSession = (sectionId) =>
  api.post("/attendance/sessions", { sectionId });
export const getAttendanceQr = (sessionId) =>
  api.get(`/attendance/sessions/${encodeURIComponent(sessionId)}/qr`);
export const endAttendanceSession = (sessionId) =>
  api.post(`/attendance/sessions/${encodeURIComponent(sessionId)}/end`);

export const getAttendanceSessions = (params = {}, config = {}) =>
  api.get("/attendance/sessions", { ...config, params });
export const getSessionAttendance = (sessionId, params = {}, config = {}) =>
  api.get(`/attendance/sessions/${encodeURIComponent(sessionId)}/records`, {
    ...config,
    params,
  });
export const getAttendanceReport = (params = {}, config = {}) =>
  api.get("/attendance/records", { ...config, params });
