# Attendance System release-readiness gates

This document is a checklist, not a deployment command. Deploy to staging manually first; do not use real student biometric data until the acceptance checks pass.

## 1. Merge gate
- Require Backend CI and Frontend CI to pass on the exact PR head.
- Review the full diff; keep secrets and real student data out of Git.
- Pull `main` after merge and run `npm ci` plus the documented test/build commands in backend, lecturer-web, and student-app.

## 2. Render environment
Set secrets in Render's environment UI:
- `MONGO_URL`: reachable, authenticated MongoDB database.
- `REDIS_URL`: reachable Redis/Key Value connection string.
- `JWT_SECRET` and `ATTENDANCE_TOKEN_SECRET`: separate high-entropy values.
- `CORS_ORIGINS`: exact deployed lecturer-web origin(s), comma-separated.
- `TRUST_PROXY_HOPS=1` for the Render reverse proxy.
- `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`: private S3-compatible bucket settings with least-privilege access.
- `BIOMETRIC_BASE_URL`, `BIOMETRIC_API_KEY`, collection/model/threshold settings for a reachable provider.
- `BIOMETRIC_PRODUCTION_APPROVED=false` until model/licence review, real-device active liveness/PAD, security testing, privacy review, and a supervised pilot have passed.
- For email recovery, configure `MAIL_USER` and `MAIL_PASSWORD`; optionally configure `MAIL_HOST`, `MAIL_PORT`, and `MAIL_SECURE` for your SMTP provider.

Render automatic deployment must remain disabled until a deliberate manual release. Verify both Blueprint configuration and the existing service dashboard setting.

## 3. Staging acceptance
1. Deploy manually to staging. Check `/api/v1/livez`, `/api/v1/health`, and `/api/v1/readyz`; readiness must reflect MongoDB/Redis and the production biometric gate.
2. With trusted storage credentials, run `cd backend && npm ci && npm run storage:smoke`. Verify upload, private unsigned access denied, signed GET returns the exact bytes, and deletion makes the object unavailable.
3. Verify email password recovery using a test account: request OTP, check expiry and attempt limits, verify OTP once, reset password once, and confirm previous JWTs are rejected.
4. With test users, verify lecturer login, course/session creation, eligible roster, rotating QR expiry, student login, device registration/signature, GPS rejection, biometric challenge and verification, attendance submission, duplicate/replay rejection, and lecturer results.
5. Test evidence consent, owner-only signed URL, explicit deletion, expiry cleanup, and retry after a storage outage. Confirm logs contain no OTPs, tokens, signed URLs, image bytes, or biometric payloads.
6. Test provider timeout/outage, wrong student/session, revoked device, stale QR, and duplicate submissions.
7. Load-test expected classroom concurrency and inspect health, logs, and operational alerts.
8. Verify backups/restore, retention and deletion policy, institution approval, privacy notice/consent, and incident procedure before production data.

## 4. Physical student app
- Set `EXPO_PUBLIC_API_BASE_URL` to the deployed HTTPS API base including `/api/v1`.
- A physical phone cannot use the PC's `localhost`; use a reachable LAN address for local testing.
- Test a native internal build on a physical device. Web export does not validate native camera, SecureStore, device-key signing, or location permissions.

## 5. Go/no-go
Green CI validates automated checks, not cloud credentials, live provider behavior, anti-spoofing performance, native camera integration, privacy/legal approval, or classroom load. Do not enable production biometrics until each relevant gate has evidence.
