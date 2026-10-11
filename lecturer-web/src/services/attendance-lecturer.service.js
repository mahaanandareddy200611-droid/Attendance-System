import api from "../api/api";

export const startAttendanceSession = (sectionId) => api.post("/attendance/sessions", { sectionId });
export const getAttendanceQr = (sessionId) => api.get(`/attendance/sessions/${encodeURIComponent(sessionId)}/qr`);
export const endAttendanceSession = (sessionId) => api.post(`/attendance/sessions/${encodeURIComponent(sessionId)}/end`);
