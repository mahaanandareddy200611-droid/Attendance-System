# Staging load testing

This repository now includes a manually triggered, guarded k6 workflow. It exists to measure a configured staging target, not to label the application production-ready without measurements.

## First run

1. Deploy the backend, Redis, MongoDB, and biometric provider to a dedicated **staging** environment. Check readiness and verify the service owner has authorized the test.
2. The allowed target is restricted to `attendance-backend-staging-n04q.onrender.com` by default. If a different authorized staging hostname is needed after provisioning a scaled environment, set the repository variable `STAGING_LOAD_TEST_ALLOWED_HOSTS` to a comma- or newline-separated exact hostname allowlist. The hostname must include `staging`; do not add production hosts. In repository settings, add `STAGING_BEARER_TOKENS` only if testing `/auth/me`. That secret must contain a pool of tokens for dedicated synthetic accounts—not student or administrator credentials—and those tokens should be rotated/revoked after the test.
3. Open **Actions → Staging Load Test → Run workflow**. Enter the HTTPS API base ending in `/api/v1`, start at `/livez` and 50 or 100 RPS, and inspect the summary before increasing load.
4. The 1,000 and 3,000 RPS profiles require the exact acknowledgement `I_APPROVE_AUTHORIZED_STAGING_LOAD_TEST`. The workflow refuses non-HTTPS targets, hosts outside the exact staging allowlist, hostnames that do not contain `staging`, write endpoints, and targets without the required token pool.
5. Review request rate, failed-request/check rate, p95/p99 latency, and server CPU/memory, Node event-loop delay, Mongo pool wait/checkout, Redis latency, provider latency, and 429/5xx logs. Attach the summary artifact to the release record.

## What this measures

The script has a gradual arrival-rate profile: 15 seconds toward 100 RPS, 20 seconds toward 300 RPS, 20 seconds toward 1,000 RPS, a configured peak period at the requested RPS, then a cool-down. Lower target profiles flatten the stages at the selected peak. Initial thresholds are:

- Less than 1% HTTP failures.
- At least 99% successful status checks.
- p95 response time below 750 ms and p99 below 1.5 seconds.

These are explicit initial acceptance targets. A failed threshold should be investigated rather than bypassed or hidden. The generated rate depends on the runner and network; k6 will report dropped iterations when it cannot create the configured arrival rate.

Only read-only `/livez`, `/health`, or authenticated `/auth/me` routes can be targeted. `/readyz` is deliberately excluded because it probes dependencies and the biometric provider. The script does not upload images or mutate attendance records.

## Critical capacity boundary

A 3,000 RPS read-route test is **not** evidence that 3,000 complete attendance check-ins per second work. An attendance attempt includes QR validation, Redis state transitions, MongoDB authorization/transaction work, a multipart request with three face frames, multiple provider inference calls, and attendance finalization. Validate that path separately with a controlled synthetic roster/provider and real staging instrumentation; never use live student images for a benchmark.

The checked-in Render blueprint currently sets the backend service to `plan: free`. Render's [scaling documentation](https://render.com/docs/scaling) states that free services are limited to one instance and cannot autoscale. Meeting sustained 3,000 RPS will need a separately budgeted deployment with measured capacity—typically multiple appropriately sized API instances, a highly available Redis deployment, a MongoDB replica set sized for the transaction/query load, and a biometric provider with enough CPU/GPU inference throughput. Keep the biometric service's production approval gate disabled until licensed models, real face-match behavior, PAD, privacy review, deletion and a supervised pilot have passed.

The existing CI concurrency test (300 submissions against CI services) remains useful, but it is neither a 3,000 RPS benchmark nor a production capacity guarantee.
