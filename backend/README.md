# Attendance backend setup

1. Copy `.env.example` to `.env` and fill in MongoDB, Redis, and generated signing secrets.
2. Start MongoDB and Redis. The backend process requires both before it listens for API traffic.
3. Install dependencies with `npm ci`, then run `npm start` (or the existing development command in your local setup).
4. To create the first Admin, set `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters), and `ADMIN_MOBILE` in `.env`, then run `npm run admin:create`. The command refuses to create a second Admin.
5. Configure `BIOMETRIC_BASE_URL` and `BIOMETRIC_API_KEY` to enable biometric flows. The API can start without them, but biometric operations return HTTP 503 until configured.

The lecturer web client uses `lecturer-web/.env.example`. The Expo client uses `student-app/.env.example`; on Android emulators, use `10.0.2.2` to reach the host machine.


## Private retained evidence storage

Retained evidence images use a private S3-compatible bucket (for example, Cloudflare R2). Configure these values in your ignored local `.env` file or the deployment provider's secret environment settings:

- `OBJECT_STORAGE_ENDPOINT`: the S3 API endpoint origin, such as `https://<account-id>.r2.cloudflarestorage.com` (do not add the bucket or key path).
- `OBJECT_STORAGE_BUCKET`: the private bucket name.
- `OBJECT_STORAGE_REGION=auto` for R2; use the region specified by the provider for other S3-compatible storage.
- `OBJECT_STORAGE_ACCESS_KEY_ID` and `OBJECT_STORAGE_SECRET_ACCESS_KEY`: a dedicated least-privilege key with access only to this bucket.
- Optional: `OBJECT_STORAGE_TIMEOUT_MS=10000`, `MEDIA_RETENTION_DAYS=30`, and `MEDIA_URL_TTL_SECONDS=60`.

Do not enable public bucket access or commit any credentials. The media API stores a metadata record in MongoDB before uploading the object, so interrupted uploads are discoverable and the cleanup sweep can retry deleting pending or expired objects.

- `POST /api/v1/media/evidence`: authenticated Lecturer/Admin multipart field `image` plus `sessionId`.
- `GET /api/v1/media/session/:sessionId`: list active retained evidence for a session the lecturer owns (or an administrator can access).
- `GET /api/v1/media/:assetId/url`: issue a short-lived signed download URL after authorization.
- `DELETE /api/v1/media/:assetId`: delete the object and record its deletion state.

Run `npm run storage:smoke` from `backend` after configuring a real private test bucket. The check uploads a temporary object, verifies an unsigned GET is denied, verifies a signed GET returns the exact bytes, and deletes the object. It intentionally fails if the bucket exposes an object publicly. This live storage check is separate from the mock-based unit tests.

Face enrollment is stored by the configured biometric provider; live verification/liveness frames are processed in memory and are not retained as evidence by the application. `DELETE /api/v1/biometric/me` requests provider-side person/face/embedding deletion and marks the local enrollment as `DELETE_PENDING` if the provider is unavailable. The periodic cleanup task retries pending deletion until the provider confirms deletion. Do not state deletion is complete while this operation remains pending.

## Active face/liveness flow

The student web client uses `POST /api/v1/biometric/challenge-active` to obtain a server-randomized center/left/right sequence and `POST /api/v1/biometric/verify-active` to submit three camera frames. The provider is expected to evaluate face detection and passive presentation-attack/liveness signals for each frame; the backend validates landmark movement and face identity before issuing a short-lived, session-bound assertion.

This layered sequence is a demo-grade control, not certified anti-spoofing. Test a consenting user, a different person, poor lighting, replay/printed-photo attempts, expired challenges, and provider outages. The public InsightFace `buffalo_l` pretrained model has non-commercial/research licensing terms in the currently reviewed license metadata; obtain an appropriate license or choose a suitably licensed model before any institutional/commercial deployment.

## Frontend/build checks

The lecturer web frontend is built and linted by `.github/workflows/frontend-ci.yml`. The Expo student app's web bundle is exported as a basic CI check; that check is not a substitute for a native Android/iOS device build or camera/key-storage validation.
