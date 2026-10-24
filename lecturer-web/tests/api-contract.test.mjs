import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeApiError } from "../src/api/errors.js";
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


test("429 errors honor Retry-After and provide calm recovery guidance", () => {
  const result = normalizeApiError({
    response: {
      status: 429,
      headers: { "Retry-After": "13" },
      data: {
        success: false,
        error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please slow down." },
      },
    },
  });

  assert.equal(result.status, 429);
  assert.match(result.message, /wait 13 seconds/i);
  assert.match(result.message, /do not need to reload/i);
});

test("429 errors without a readable Retry-After still explain what to do", () => {
  const result = normalizeApiError({
    response: {
      status: 429,
      headers: {},
      data: { error: { message: "Too many requests." } },
    },
  });

  assert.match(result.message, /wait a moment/i);
  assert.match(result.message, /do not need to reload/i);
});

test("student QR, enrollment and liveness pages share the 429-aware formatter", () => {
  for (const path of [
    "src/Pages/StudentAcademic.jsx",
    "src/Pages/StudentFaceEnrollment.jsx",
    "src/components/ActiveLivenessCapture.jsx",
  ]) {
    assert.ok(
      frontend(path).includes("getApiErrorMessage(error"),
      `${path} should use the shared API error formatter`,
    );
  }
});

test("active liveness UI follows the backend five-frame challenge contract", () => {
  const backendBiometric = read("backend/src/modules/Biometric/BiometricService.js");
  const livenessService = frontend("src/services/biometric.service.js");
  const livenessCapture = frontend("src/components/ActiveLivenessCapture.jsx");
  const studentBiometric = read("student-app/src/lib/biometric.ts");

  assert.ok(backendBiometric.includes("const steps = ['CENTER', ...directions]"));
  assert.match(livenessService, /challenge\.steps\.length !== 5/);
  assert.match(livenessService, /frames\.length !== 5/);
  assert.match(livenessCapture, /issuedSteps\.length === 5/);
  assert.match(livenessCapture, /currentStep < challenge\.steps\.length - 1/);
  assert.match(livenessCapture, /Step \{currentStep \+ 1\} of \{challenge\.steps\.length\}/);
  assert.match(livenessCapture, /Five brief live frames/);
  assert.match(studentBiometric, /frames\.length !== 5/);
});

test("biometric and QR requests allow provider processing and Render cold starts", () => {
  const render = read("render.yaml");
  const livenessService = frontend("src/services/biometric.service.js");
  const studentBiometric = read("student-app/src/lib/biometric.ts");
  const studentAttendance = read("student-app/src/lib/attendance.ts");
  const lecturerAttendance = frontend("src/services/attendance.service.js");

  assert.match(render, /key: BIOMETRIC_TIMEOUT_MS\s+value: "30000"/);
  assert.match(livenessService, /timeout: 30000/);
  assert.match(livenessService, /timeout: 120000/);
  assert.match(lecturerAttendance, /validate-qr", \{ token \}, \{ timeout: 90000 \}/);
  assert.match(studentBiometric, /timeoutMs: 30000/);
  assert.match(studentBiometric, /timeoutMs: 120000/);
  assert.match(studentAttendance, /timeoutMs: 90000/);
});

 
test("face enrollment and approval requests allow Render startup and provider processing", () => {
  const lecturerBiometric = frontend("src/services/biometric.service.js");
  const studentBiometric = read("student-app/src/lib/biometric.ts");

  assert.match(lecturerBiometric, /getMyBiometricEnrollment.*timeout: 90000/);
  assert.match(lecturerBiometric, /getPendingBiometricEnrollments.*timeout: 90000/);
  assert.ok(lecturerBiometric.includes('approve`, {}, { timeout: 90000 });'));
  assert.ok(lecturerBiometric.includes('reject`, {}, { timeout: 90000 });'));
  assert.ok(lecturerBiometric.includes('return api.post("/biometric/enroll", form, { timeout: 90000 });'));
  assert.match(studentBiometric, /timeoutMs: 120000/);
  assert.match(studentBiometric, /timeoutMs: 90000/);
});
