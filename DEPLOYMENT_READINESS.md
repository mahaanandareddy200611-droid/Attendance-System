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
- For the real provider, the API contract must match the backend's /v1/collections/{id}/persons, /search, and /v1/detect calls. Require API-key authentication, an initialized students collection, an installed recognition model, and an enabled liveness addon. The official InsightFace Server documentation says liveness is disabled by default; model licensing must be reviewed and explicitly accepted by the service owner before installation.
- Run the non-mocked provider smoke locally with two different captures of the same consenting test subject (never real student evidence): set BIOMETRIC_SMOKE_ENROLL_IMAGE_PATH and BIOMETRIC_SMOKE_VERIFY_IMAGE_PATH, then run cd backend && npm ci && npm run biometric:smoke. It validates provider readiness/auth, collection access, face detection, positive liveness, enrollment, matching a second capture, and cleanup of the temporary enrollment. It does not prove resistance to print/video replay or replace a supervised pilot.
- `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`: private Backblaze B2 S3-compatible storage settings. Use a dedicated bucket-scoped application key (not the account master key) with `listFiles`, `readFiles`, `writeFiles`, and `deleteFiles`. Permanent version deletion needs listing plus version-specific deletion; Backblaze also requires `writeFiles` for delete-by-name operations. The app does not need to list all bucket names, so avoid that extra capability unless separately needed.
- For Backblaze B2, `OBJECT_STORAGE_PURGE_VERSIONS=true` permanently removes prior object versions and delete markers; verify with the provider smoke test before accepting evidence deletion.
- `MAIL_USER`, `MAIL_PASSWORD`; optionally `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE` for SMTP. Without `MAIL_HOST`, the legacy Gmail transport is used.
- For actual delivery, configure `MAIL_SMOKE_TO` to a test inbox and run `cd backend && npm ci && npm run mail:smoke` (or trigger GitHub Actions → Staging Email Smoke Test). For OTP/password recovery end-to-end, use only a dedicated staging test account: set `STAGING_BASE_URL`, `AUTH_RECOVERY_TEST_EMAIL`, `AUTH_RECOVERY_CURRENT_PASSWORD`, and `AUTH_RECOVERY_NEW_PASSWORD`, then run `cd backend && npm run password-recovery:smoke`. It prompts for the actual delivered OTP without logging it, tests password update, proves the prior password and access token are rejected, and checks the new login. This test mutates the dedicated test account's password.
- Set lecturer web `VITE_API_BASE_URL` and student app `EXPO_PUBLIC_API_BASE_URL` to the deployed HTTPS API base ending in `/api/v1`.
- Keep `TRUST_PROXY_HOPS=1` for Render and `BIOMETRIC_PRODUCTION_APPROVED=false` in staging. Production approval requires a supervised and reviewed pilot.

Do not put server credentials in Vite or Expo public environment variables.

## 3. After a manual staging deployment

On Windows, after the services and secrets are configured, the real external checks can be run as one interactive pass from the repo:

`powershell -ExecutionPolicy Bypass -File .\backend\scripts\run-release-acceptance.ps1`

The runner prompts for any missing values without printing secret inputs, requires an explicit confirmation phrase before making requests, and executes deployment readiness, version-aware B2 deletion, real email delivery, biometric collection setup, live provider face/liveness/matching plus temporary enrollment deletion, and the real OTP/reset flow. It deletes prompted secrets from the current process environment at the end. The reset smoke intentionally changes the dedicated test account's password and uses two different captures of the same consenting test person; never use student images.

1. GitHub Actions → **Staging Smoke Test**: enter both the deployed API base URL and lecturer static-site origin. Its health requests allow up to 60 seconds for a cold Render instance to wake. It checks `/api/v1/livez`, `/api/v1/health`, and `/api/v1/readyz`; fetches the lecturer site's built React HTML and JavaScript bundle; and sends a real CORS preflight using the exact lecturer origin. Readiness must confirm MongoDB/Redis and the configured required providers.
2. GitHub Actions → **Private Storage Smoke Test**: first add repository Actions secrets `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` and (if needed) a repository variable `OBJECT_STORAGE_REGION`. The workflow writes a random test object under `smoke-tests/`, confirms unsigned access is denied, checks signed-download bytes, permanently purges every file version and delete marker, and verifies the object is unreadable. Ensure `OBJECT_STORAGE_PURGE_VERSIONS=true` is enabled for the live smoke.
3. GitHub Actions → **Staging Email Smoke Test**: configure Actions secrets `MAIL_USER`, `MAIL_PASSWORD`, and optional `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, then provide a test inbox. It sends one non-sensitive email. Run `password-recovery:smoke` against staging to verify the real delivered OTP and reset/token invalidation. The OTP's expiry and attempt limits also have automated tests.
4. With a seeded test account, complete the lecturer session → fresh QR → student login → active liveness → signed device request → location validation → attendance submission → lecturer results flow. Try wrong role, wrong student/session, stale/replayed QR, expired/reused assertions, bad signature, revoked device, duplicate idempotency key and stale/inaccurate/out-of-geofence location.
5. Verify evidence consent, attendance ownership, short-lived owner-only signed links, explicit deletion, retention expiry and retries during a storage outage.
6. Test on a physical phone: native camera, SecureStore/device-key signing, location permission denial and network reachability. Expo web export does not validate native behavior.
7. CI includes 300 concurrent test submissions against CI services. Also load-test staging at expected classroom scale with synthetic accounts and inspect p95/p99 latency, errors, connection pools, and logs.


### Dedicated InsightFace staging provider

- `biometric-provider/render.yaml` is a separate, optional Render Blueprint for the compatible provider. It uses the pinned `ghcr.io/deepinsight/insightface-server:0.3.1-cpu` image, API-only mode, bearer-key authentication, and a 5 GB persistent disk for `/data` (including SQLite and `/data/models`).
- The model installer is deliberately gated by the required `BIOMETRIC_MODEL_LICENSE_ACCEPTED=true` environment setting. Read the selected model's terms first. Public InsightFace pretrained models are for non-commercial research unless separate authorization is obtained; do not set the flag if the intended use is outside the licence. The image has no model weights and will not start before this gate is satisfied.
- This provider is not free: Render requires a paid service for persistent disks. The current `1c-2g` instance plus 5 GB disk has recurring compute and storage cost; review current Render pricing before provisioning. No service was deployed by committing this template.
- After creating the provider Blueprint and confirming its `/v1/health` endpoint, set `BIOMETRIC_BASE_URL` to the provider's HTTPS origin and set backend `BIOMETRIC_API_KEY` to the exact same secret as provider `INSIGHTFACE_API_KEY`. Then run `cd backend && npm ci && npm run biometric:bootstrap` to create (or validate) the empty `students` Collection, and `npm run biometric:smoke` with two different captures of one consenting test subject. Never use live student photos for this smoke.
- The live-image smoke does not prove presentation-attack resistance against prints, screen replay or deepfakes. Keep `BIOMETRIC_PRODUCTION_APPROVED=false` until PAD testing, privacy/institution review, retention/deletion checks and a supervised pilot have passed.

## 4. Biometric and production safety
The new active-sequence integration test uses mocked provider detection so it validates challenge binding, ordering, assertion creation and replay rejection. It does not prove real camera capture, face matching, active presentation-attack detection (PAD), model licence, accuracy or spoof resistance. Three head-turn frames alone are not robust PAD.
Do not collect actual student biometric data until provider behaviour, model/licence, independent PAD, privacy/institution approval, retention/deletion policy, incident response and supervised pilot are reviewed.

A green CI run proves automated tests and the Docker build. A successful health smoke proves the deployed process and reported dependencies. The manual storage/email checks and real-device attendance workflow are needed to accept the prototype demo.
