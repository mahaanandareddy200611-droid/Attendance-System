# Attendance backend setup

1. Copy `.env.example` to `.env` and fill in MongoDB, Redis, and generated signing secrets.
2. Start MongoDB and Redis. The backend process requires both before it listens for API traffic.
3. Install dependencies with `npm ci`, then run `npm start` (or the existing development command in your local setup).
4. To create the first Admin, set `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters), and `ADMIN_MOBILE` in `.env`, then run `npm run admin:create`. The command refuses to create a second Admin.
5. Configure `BIOMETRIC_BASE_URL` and `BIOMETRIC_API_KEY` to enable biometric flows. The API can start without them, but biometric operations return HTTP 503 until configured.

The lecturer web client uses `lecturer-web/.env.example`. The Expo client uses `student-app/.env.example`; on Android emulators, use `10.0.2.2` to reach the host machine.
