# Attendance-System handoff

Updated: 2026-10-23 (Asia/Kolkata)

## Repository and delivery
- Repository: https://github.com/mahaanandareddy200611-droid/Attendance-System
- Pull request: https://github.com/mahaanandareddy200611-droid/Attendance-System/pull/37
- Task branch: feat/qr-camera-redis-biometric-approval
- Base commit: 54159f5fd54d6541f4ae470680e7e5f2dc8111e9
- The task is kept as one consolidated commit on top of the base. The current PR head SHA and CI run IDs are the authoritative evidence.
- Do not merge or deploy automatically. The user will inspect, merge and deploy manually.

## Student experience
1. The student has a dedicated Face enrollment page at /student/face-enrollment and can submit a face profile after registration without needing an active attendance QR.
2. The page uses navigator.mediaDevices.getUserMedia with a front-facing camera, attaches the stream to a real video element, waits for metadata/decoded dimensions, checks camera permission/device errors, compresses the capture and stops tracks on exit.
3. Enrollment status is explicit: NOT_ENROLLED -> PENDING_APPROVAL -> ACTIVE, with DELETE_PENDING / REJECTED / REVOKED handled as distinct visible states.
4. An assigned lecturer (only where the student has an active enrollment in one of that lecturer's active sections) or an Admin may approve/reject. Server-side role and section checks enforce review permissions. Rejection disables the profile before provider deletion; failed provider deletion stays pending for the cleanup sweeper.
5. Attendance remains QR-first: student opens rear camera, the camera target is shown before Html5Qrcode initializes, QR is decoded locally and checked by the backend, then the ticket enables liveness/matching. If no enrollment exists in this path, it still offers a convenient enrollment link/fallback.
6. After approval, the student must refresh status/scan a fresh QR, finish the active liveness flow and match their enrolled face before attendance records are written.
7. Browser attendance does not require device registration/keys or GPS. Legacy backend device/GPS routes remain for compatibility but this browser path does not call them.

## QR / Redis architecture
- QR target cadence: 1500 ms. This is intentionally fast but camera-decodable; 10–20 ms rotations are not appropriate for video QR acquisition.
- QR nonce challenge TTL: 5000 ms. One previous slot is accepted according to QR_ALLOWED_SKEW_SLOTS; check Render environment after deployment.
- Server QR-validation tickets use Redis Lua transitions ISSUED -> CLAIMED -> CONSUMED, preserving PTTL. Known uncommitted failures release the claim; successful attendance MongoDB commit is followed by Redis finalization.
- Redis stores ephemeral challenge/replay/ticket/rate-limit/biometric-assertion state and SET-NX enrollment reservations. MongoDB remains the durable source for enrollment, roster and attendance.
- There is a Redis integration test for ticket TTL, ownership, claim/release/finalization and exactly-one-winner concurrent claims.

## Key paths
- lecturer-web/src/Pages/StudentAcademic.jsx: QR-first attendance camera and fallback enrollment.
- lecturer-web/src/Pages/StudentFaceEnrollment.jsx: standalone enrollment workflow.
- lecturer-web/src/Pages/BiometricEnrollmentApprovals.jsx: lecturer/admin review UI.
- lecturer-web/src/components/ActiveLivenessCapture.jsx: real front-camera stream and active challenge.
- lecturer-web/src/App.jsx, WorkspaceHeader.jsx, biometric.service.js, Academic.css: roles, route, menu, API and responsive styling.
- lecturer-web/tests/e2e-smoke.cjs: Playwright QR-camera, independent enrollment and review tests.
- backend/src/modules/Attendance/QrChallengeService.js and AttendanceService.js: atomic ticket state.
- backend/src/modules/Biometric/BiometricService.js, BiometricController.js, BiometricRoutes.js and models/BiometricEnrollment.model.js: pending review state machine and server-side authorization.
- backend/test/biometric-approval-contract.test.js and backend/test/qr-validation-ticket.integration.test.js: enrollment/review contracts and real Redis lifecycle/race checks.
- backend/src/utils/attendanceToken.js, backend/.env.example and render.yaml: QR cadence and TTL settings.

## Verified on the last observed successful pre-standalone-enrollment revision
- Backend CI run 39763523914: success, including unit/database/Redis integration tests and backend Docker/provider builds.
- Frontend CI run 39763523847: success, both lecturer-web and student-app jobs; lecturer-web browser E2E had 13/13 passing; lint passed.
- Those CI results are for the previous PR head before the independent-enrollment page/test was added. They must not be used to claim the new revision passed; check fresh workflows for the final head before merge.

## Release acceptance still required
- Browser CI uses Chromium fake media. It is not proof of a physical phone/laptop camera working on Render.
- After merge/deploy, test authorized student/lecturer accounts over HTTPS: student registration, independent face enrollment, pending review, lecturer approve/reject, refresh/new QR, real provider face matching, active liveness/PAD, attendance persistence, lecturer result screen and error/retry states.
- Keep BIOMETRIC_PRODUCTION_APPROVED=false until provider licensing/production acceptance and PAD gates are fulfilled.
- Test multiple API instances against the same Redis and transaction-capable MongoDB, and run staging load/concurrency tests before claiming a specific capacity such as 3,000 users.
- Never claim the full deployed system is 100% live-verified from build/mocked tests alone. Record the final PR head SHA, workflow run IDs and observed live acceptance results here and in the Library handoff after the final CI completes.
