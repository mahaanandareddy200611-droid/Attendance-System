# Attendance System: merge and manual deployment checklist

This change does not deploy the service. Keep Render deployment manual until staging checks pass.

## Before merging
- Confirm the latest Backend CI and Frontend CI are successful.
- Review the PR diff and merge the latest PR head into `main`.
- Pull updated `main` locally and follow the backend, lecturer-web, and student-app README instructions.

## Required Render backend settings
Set secrets in Render's environment-variable UI; never commit secrets:
- `MONGO_URL`: reachable MongoDB deployment with authentication/network access configured.
- `REDIS_URL`: reachable Redis/Key Value connection string.
- `JWT_SECRET` and `ATTENDANCE_TOKEN_SECRET`: separate high-entropy secrets.
- `CORS_ORIGINS`: exact deployed lecturer-web origin(s), comma-separated.
- `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`: private S3-compatible bucket settings. Do not make the bucket public.
- `BIOMETRIC_BASE_URL` and `BIOMETRIC_API_KEY`: reachable deployed biometric provider if biometric attendance is enabled.
- Mail variables only if password-recovery email is required.

Use the exact variable names read by the application. Keep `BIOMETRIC_PRODUCTION_APPROVED=false` until real-device liveness/PAD, model/licence review, device-binding, and pilot checks pass.

## Staging verification before real student data
1. Deploy manually to staging and wait for `/api/v1/readyz` to report healthy.
2. With storage credentials in a trusted environment, run `cd backend && npm ci && npm run storage:smoke`. It must confirm upload, unsigned access denied, signed download returns identical bytes, and deletion makes the object unavailable.
3. Verify student/lecturer login, session creation, rotating QR, challenge expiry/replay rejection, device binding, GPS rejection, attendance submission, and lecturer dashboard with test accounts.
4. Verify biometric enrollment and active liveness on a real supported camera/device against the deployed provider. Test spoof/replay attempts; an API success alone is not a PAD evaluation.
5. Verify consented evidence upload, owner-only signed URL, explicit deletion, retention expiry, and retry after storage outage. Confirm bucket privacy and that signed URLs/image bytes never appear in logs.
6. Run expected classroom concurrency and failure tests; inspect logs and health checks before production enablement.

## Limits
Green CI proves automated tests/builds pass; it does not prove cloud credentials, camera/liveness, legal/privacy approval, deployed frontend integration, or classroom-scale behavior. Do not collect real student biometric data until institutional approval, notice/consent, retention/deletion policy, and access controls have been reviewed.
