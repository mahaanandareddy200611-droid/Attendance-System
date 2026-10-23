const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BiometricEnrollment = require("../src/models/BiometricEnrollment.model");

const root = path.resolve(__dirname, "..");

test("biometric enrollment model supports explicit pending, approved, rejected and deletion states", () => {
  const statuses = BiometricEnrollment.schema.path("status").enumValues;
  for (const status of ["PENDING_APPROVAL", "ACTIVE", "DELETE_PENDING", "REJECTED", "REVOKED"]) {
    assert.ok(statuses.includes(status), `missing status: ${status}`);
  }
  assert.equal(BiometricEnrollment.schema.path("reviewDecision").defaultValue, "PENDING");
  const service = fs.readFileSync(path.join(root, "src/modules/Biometric/BiometricService.js"), "utf8");
  assert.match(service, /\.sort\(\{ updatedAt: -1 \}\)\.select\("status provider modelVersion/);
});

test("new student face enrollment is stored pending and active liveness still requires ACTIVE", () => {
  const service = fs.readFileSync(path.join(root, "src/modules/Biometric/BiometricService.js"), "utf8");
  assert.match(service, /status:\s*"PENDING_APPROVAL"/);
  assert.match(service, /exports\.createActiveChallenge\s*=\s*async[\s\S]*?status:\s*['"]ACTIVE['"]/);
  assert.match(service, /exports\.approveEnrollment\s*=\s*async/);
  assert.match(service, /reviewDecision:\s*"APPROVED"/);
});

test("review routes require an authenticated lecturer or admin role", () => {
  const routes = fs.readFileSync(path.join(root, "src/modules/Biometric/BiometricRoutes.js"), "utf8");
  assert.match(routes, /"\/enrollment-approvals",[\s\S]*?Auth,[\s\S]*?authorize\("Lecturer", "Admin"\)/);
  assert.match(routes, /"\/enrollment-approvals\/:studentId\/approve",[\s\S]*?Auth,[\s\S]*?authorize\("Lecturer", "Admin"\)/);
  assert.match(routes, /"\/enrollment-approvals\/:studentId\/reject",[\s\S]*?Auth,[\s\S]*?authorize\("Lecturer", "Admin"\)/);
});

test("lecturer review service restricts students to assigned active sections and audits decisions", () => {
  const service = fs.readFileSync(path.join(root, "src/modules/Biometric/BiometricService.js"), "utf8");
  assert.match(service, /assertReviewerCanReviewStudent/);
  assert.match(service, /lecturers:\s*reviewerId/);
  assert.match(service, /BIOMETRIC_ENROLLMENT_APPROVED/);
  assert.match(service, /BIOMETRIC_ENROLLMENT_REJECTED/);
  assert.match(service, /provider\.deletePerson/);
});

test("QR validation ticket lifecycle uses Redis atomic state transitions and preserves expiry TTL", () => {
  const service = fs.readFileSync(path.join(root, "src/modules/Attendance/QrChallengeService.js"), "utf8");
  assert.match(service, /exports\.claimQrValidationTicket/);
  assert.match(service, /exports\.releaseQrValidationTicket/);
  assert.match(service, /exports\.finalizeQrValidationTicket/);
  assert.match(service, /redis\.call\("PTTL", KEYS\[1\]\)/);
  assert.match(service, /ticket\.state = "CONSUMED"/);
  const attendance = fs.readFileSync(path.join(root, "src/modules/Attendance/AttendanceService.js"), "utf8");
  assert.match(attendance, /claimQrValidationTicket/);
  assert.match(attendance, /finalizeQrValidationTicket/);
});
