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
