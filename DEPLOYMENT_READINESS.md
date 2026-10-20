# Attendance System prototype release gates

The Render Blueprint deliberately disables automatic deployment. The application CI validates code and the Docker artifact; the manually triggered smoke workflows validate actual configured services. Those are different gates.

## 1. Merge gate
- Require Backend CI and Frontend CI to pass on the exact latest PR head.
- Root `render.yaml` is the canonical Render Docker Blueprint; the conflicting `backend/render.yaml` has been removed.
- Never commit credentials, sample face images, biometric templates, OTPs, tokens, or signed URLs.
- Backend CI runs real MongoDB replica-set/Redis integration tests, the full attendance API flow, private-storage adapter tests, and the 300-client concurrency test. The biometric provider is mocked in those CI tests.

## 2. Render environment
Configure the following in Render's Environment UI. Required staging feature gates are true; startup intentionally exits with the names of missing or invalid values.

- `MONGO_URL`: reachable authenticated MongoDB URI; transaction workflows require replica-set support.
- `REDIS_URL`: reachable Redis/Key Value connection string. The Blueprint wires its Redis service automatically.
- `JWT_SECRET` and `ATTENDANCE_TOKEN_SECRET`: distinct random secrets of at least 32 characters.
- `CORS_ORIGINS`: exact lecturer web HTTPS origin(s), comma-separated.
- `BIOMETRIC_BASE_URL`, `BIOMETRIC_API_KEY`, `BIOMETRIC_COLLECTION_ID`, model/threshold settings for a compatible deployed provider.
- `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`: private S3-compatible bucket credentials with least privilege.
- `MAIL_USER`, `MAIL_PASSWORD`; optionally `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE` for SMTP. Without `MAIL_HOST`, the legacy Gmail transport is used.
- Set lecturer web `VITE_API_BASE_URL` and student app `EXPO_PUBLIC_API_BASE_URL` to the deployed HTTPS API base ending in `/api/v1`.
- Keep `TRUST_PROXY_HOPS=1` for Render and `BIOMETRIC_PRODUCTION_APPROVED=false` in staging. Production approval requires a supervised and reviewed pilot.

Do not put server credentials in Vite or Expo public environment variables.

## 3. After a manual staging deployment
1. GitHub Actions → **Staging Smoke Test**: enter the deployed API base URL (origin or URL ending in `/api/v1`). It verifies `/api/v1/livez`, `/api/v1/health` and `/api/v1/readyz`, including MongoDB/Redis and required feature configuration.
2. GitHub Actions → **Private Storage Smoke Test**: first add repository Actions secrets `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` and (if needed) a repository variable `OBJECT_STORAGE_REGION`. The workflow writes a random test object under `smoke-tests/`, confirms unsigned access is denied, checks the signed download bytes, deletes the object and verifies it is unreadable.
3. GitHub Actions → **Staging Email Smoke Test**: configure Actions secrets `MAIL_USER`, `MAIL_PASSWORD`, and the optional `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, then provide a test inbox. It sends one non-sensitive email. Also execute the actual password-reset flow with a dedicated test account to validate OTP expiry, attempt limits, single use and token-version invalidation.
4. With a seeded test account, complete the lecturer session → fresh QR → student login → active liveness → signed device request → location validation → attendance submission → lecturer results flow. Try wrong role, wrong student/session, stale/replayed QR, expired/reused assertions, bad signature, revoked device, duplicate idempotency key and stale/inaccurate/out-of-geofence location.
5. Verify evidence consent, attendance ownership, short-lived owner-only signed links, explicit deletion, retention expiry and retries during a storage outage.
6. Test on a physical phone: native camera, SecureStore/device-key signing, location permission denial and network reachability. Expo web export does not validate native behavior.
7. CI includes 300 concurrent test submissions against CI services. Also load-test staging at expected classroom scale with synthetic accounts and inspect p95/p99 latency, errors, connection pools, and logs.

## 4. Biometric and production safety
The new active-sequence integration test uses mocked provider detection so it validates challenge binding, ordering, assertion creation and replay rejection. It does not prove real camera capture, face matching, active presentation-attack detection (PAD), model licence, accuracy or spoof resistance. Three head-turn frames alone are not robust PAD.
Do not collect actual student biometric data until provider behaviour, model/licence, independent PAD, privacy/institution approval, retention/deletion policy, incident response and supervised pilot are reviewed.

A green CI run proves automated tests and the Docker build. A successful health smoke proves the deployed process and reported dependencies. The manual storage/email checks and real-device attendance workflow are needed to accept the prototype demo.
