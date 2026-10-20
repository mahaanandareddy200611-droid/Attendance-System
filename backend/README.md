# Attendance backend setup

1. Copy `.env.example` to `.env` and fill in MongoDB, Redis, and generated signing secrets.
2. Start MongoDB and Redis. The backend process requires both before it listens for API traffic.
3. Install dependencies with `npm ci`, then run `npm start` (or the existing development command in your local setup).
4. To create the first Admin, set `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters), and `ADMIN_MOBILE` in `.env`, then run `npm run admin:create`. The command refuses to create a second Admin.
5. Configure `BIOMETRIC_BASE_URL` and `BIOMETRIC_API_KEY` to enable biometric flows. The API can start without them, but biometric operations return HTTP 503 until configured.

The lecturer web client uses `lecturer-web/.env.example`. The Expo client uses `student-app/.env.example`; on Android emulators, use `10.0.2.2` to reach the host machine.


## Optional private attendance evidence

Attendance evidence retention is separate from biometric verification. Enrollment and active-liveness frames are processed in memory and are not retained by this feature. A student may upload one normalized JPEG as corroborative evidence for an attendance record that belongs to them, only after explicitly accepting the versioned retention notice. Retention defaults to 7 days and is configurable from 1 to 30 days.

1. Configure the existing private S3-compatible object storage (`OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY`). Use a dedicated access key scoped to the private bucket. Do not make the bucket public.
2. The evidence feature reuses the same private object-storage adapter as session media. No Supabase-specific credentials or second storage provider are required.
3. Configure `ATTENDANCE_EVIDENCE_RETENTION_DAYS` and review your institution's consent, access, retention, and deletion policy before enabling collection.
4. The student API is `POST /api/v1/attendance-evidence` as multipart form data: `image`, `attendanceRecordId`, `retentionConsent=true`, and `consentVersion=attendance-evidence-v1`. Authenticated students can request a 60-second signed URL at `GET /api/v1/attendance-evidence/:evidenceId/signed-url` and request deletion at `DELETE /api/v1/attendance-evidence/:evidenceId`.
5. Run `npm run evidence:cleanup` from a scheduler at least daily. It retries expired/pending deletions. Orphan-object listing/deletion is intentionally not part of the automated cleanup. The scheduled cleanup only deletes objects referenced by MongoDB metadata, avoiding accidental deletion of unrelated bucket contents.

The API stores object metadata in MongoDB, never image bytes. A remote delete failure leaves metadata in `DELETE_PENDING` so signed-URL issuance stays blocked and cleanup can retry. Signed URLs are bearer links: keep them private and never log or persist them. Storage provider access, consent language, institutional policy, and live deletion behavior still require staging verification.
