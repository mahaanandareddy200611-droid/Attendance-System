import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const read = (path) => readFileSync(resolve(process.cwd(), "..", path), "utf8");
const frontend = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const expectedOrigin = "https://attendance-backend-staging-n04q.onrender.com/api/v1";

test("Render and frontend CI use the intended staging API origin", () => {
  const render = read("render.yaml");
  const workflow = read(".github/workflows/frontend-ci.yml");
  assert.ok(render.includes(expectedOrigin), "Render static site API origin is missing or stale");
  assert.ok(workflow.includes(expectedOrigin), "CI API origin is missing or stale");
  assert.ok(!render.includes("attendance-backend-staging.onrender.com"));
  assert.ok(!workflow.includes("attendance-backend-staging.onrender.com"));
});

test("lecturer API service paths stay aligned with their backend routers", () => {
  const attendanceService = frontend("src/services/attendance-lecturer.service.js");
  const attendanceRouter = read("backend/src/modules/Attendance/AttendanceRouter.js");
  const authService = frontend("src/services/auth.service.js");
  const authRouter = read("backend/src/modules/Auth/AuthRouter.js");
  const academicService = frontend("src/services/academic.service.js");
  const academicRouter = read("backend/src/modules/academic/AcademicRoutes.js");

  assert.ok(attendanceService.includes('api.post("/attendance/sessions"'));
  assert.ok(attendanceService.includes("/attendance/sessions/"));
  assert.ok(attendanceService.includes("/qr"));
  assert.ok(attendanceService.includes("/records"));
  assert.ok(attendanceRouter.includes('AttendanceRouter.post(\n    "/sessions"'));
  assert.ok(attendanceRouter.includes('"/sessions/:sessionId/qr"'));
  assert.ok(attendanceRouter.includes('"/sessions/:sessionId/records"'));
  assert.ok(attendanceRouter.includes('AttendanceRouter.get("/records"'));

  assert.ok(authService.includes('api.post("/auth/login"'));
  assert.ok(authService.includes('api.post("/auth/forget-password"'));
  assert.ok(authRouter.includes('"/login"'));
  assert.ok(authRouter.includes('"/forget-password"'));
  assert.ok(academicService.includes('api.post("/academic/courses"'));
  assert.ok(academicService.includes('api.post("/academic/sections"'));
  assert.ok(academicRouter.includes('"/courses"'));
  assert.ok(academicRouter.includes('"/sections"'));
});

test("Student web services align with QR preflight, biometric, attendance, and media routes", () => {
  const attendanceService = frontend("src/services/attendance.service.js");
  const attendanceRouter = read("backend/src/modules/Attendance/AttendanceRouter.js");
  const attendanceValidator = read("backend/src/modules/Attendance/AttendanceValidator.js");
  const application = read("backend/src/app.js");
  const biometricService = frontend("src/services/biometric.service.js");
  const biometricRouter = read("backend/src/modules/Biometric/BiometricRoutes.js");
  const mediaService = frontend("src/services/media.service.js");
  const mediaRouter = read("backend/src/modules/Media/MediaRoutes.js");

  assert.ok(attendanceService.includes('api.get("/attendance/records/me"'));
  assert.ok(attendanceService.includes('api.get("/attendance/sessions/available"'));
  assert.ok(attendanceService.includes('api.post("/attendance/preflight"'));
  assert.ok(attendanceService.includes('"/attendance/verify"'));
  assert.ok(attendanceService.includes("checkinIntentId"));
  assert.ok(attendanceRouter.includes('"/preflight"'));
  assert.ok(attendanceRouter.includes('"/records/me"'));
  assert.ok(attendanceRouter.includes('"/sessions/available"'));
  assert.ok(attendanceRouter.includes('"/verify"'));
  assert.ok(attendanceValidator.includes("checkinIntentId: Joi.string().uuid().required()"));
  assert.ok(attendanceValidator.includes("exports.preflightQr"));
  assert.equal(application.includes('app.use("/api/v1/devices"'), false,
    "Device registration endpoints must not be mounted in the active backend API");

  assert.ok(biometricService.includes('api.get("/biometric/me"'));
  assert.ok(biometricService.includes('api.post("/biometric/enroll"'));
  assert.ok(biometricService.includes('api.post("/biometric/challenge-active"'));
  assert.ok(biometricService.includes('api.post("/biometric/verify-active"'));
  assert.ok(biometricRouter.includes('"/enroll"'));
  assert.ok(biometricRouter.includes('"/challenge-active"'));
  assert.ok(biometricRouter.includes('"/verify-active"'));

  assert.ok(mediaService.includes('api.post("/media/evidence"'));
  assert.ok(mediaService.includes('/media/session/'));
  assert.ok(mediaService.includes('/url'));
  assert.ok(mediaRouter.includes('"/evidence"'));
  assert.ok(mediaRouter.includes('"/session/:sessionId"'));
  assert.ok(mediaRouter.includes('"/:assetId/url"'));
});

test("shared academic styles are loaded by the application entry point", () => {
  const entry = frontend("src/main.jsx");
  assert.ok(entry.includes('./Styles/Academic.css'),
    "Role dashboards must not depend on another lazy page importing the shared stylesheet");
});
