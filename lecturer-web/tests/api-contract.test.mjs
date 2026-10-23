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
