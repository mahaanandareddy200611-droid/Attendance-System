const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { redisClient, connectRedis } = require("../src/config/redis");
const {
  createQrValidationTicket,
  getQrValidationTicket,
  claimQrValidationTicket,
  releaseQrValidationTicket,
  finalizeQrValidationTicket,
} = require("../src/modules/Attendance/QrChallengeService");

const cleanupKeys = new Set();

after(async () => {
  if (!redisClient.isOpen) return;
  if (cleanupKeys.size) await redisClient.del([...cleanupKeys]).catch(() => {});
  await redisClient.quit();
});

async function ensureRedis(t) {
  if (!process.env.REDIS_URL) {
    t.skip("REDIS_URL is not configured; CI supplies a shared Redis service.");
    return false;
  }
  if (!redisClient.isOpen) await connectRedis();
  return true;
}

async function createTicket(studentId) {
  const created = await createQrValidationTicket({
    studentId,
    sessionId: "redis-ticket-session",
    sessionRecordId: crypto.randomUUID(),
    token: "test-token-" + crypto.randomUUID(),
    slot: Math.floor(Date.now() / 1500),
    nonce: crypto.randomBytes(16).toString("base64url"),
  });
  cleanupKeys.add("attendance:qr-validation:" + created.validationId);
  return created.validationId;
}

test("Redis QR tickets preserve TTL and atomically claim, release and consume", async (t) => {
  if (!(await ensureRedis(t))) return;

  const studentId = "redis-ticket-student-" + crypto.randomUUID();
  const validationId = await createTicket(studentId);
  const key = "attendance:qr-validation:" + validationId;
  const initial = await getQrValidationTicket({ validationId });
  assert.equal(initial.state, "ISSUED");

  const ttlBeforeClaim = await redisClient.pTTL(key);
  assert.ok(ttlBeforeClaim > 0);

  await assert.rejects(
    claimQrValidationTicket({ validationId, studentId: "another-student", idempotencyKey: "wrong-owner" }),
    /does not belong to this student/,
  );

  await claimQrValidationTicket({ validationId, studentId, idempotencyKey: "operation-one" });
  assert.equal((await getQrValidationTicket({ validationId })).state, "CLAIMED");
  const ttlAfterClaim = await redisClient.pTTL(key);
  assert.ok(ttlAfterClaim > 0 && ttlAfterClaim <= ttlBeforeClaim, "claim must not extend authorization TTL");

  await assert.rejects(
    claimQrValidationTicket({ validationId, studentId, idempotencyKey: "operation-two" }),
    /already been used or is being processed/,
  );

  assert.equal(await releaseQrValidationTicket({ validationId, idempotencyKey: "operation-one" }), true);
  assert.equal((await getQrValidationTicket({ validationId })).state, "ISSUED");

  await claimQrValidationTicket({ validationId, studentId, idempotencyKey: "operation-two" });
  assert.equal(await finalizeQrValidationTicket({ validationId, idempotencyKey: "operation-two" }), true);
  assert.equal((await getQrValidationTicket({ validationId })).state, "CONSUMED");
  assert.equal(await finalizeQrValidationTicket({ validationId, idempotencyKey: "operation-two" }), true);

  await assert.rejects(
    claimQrValidationTicket({ validationId, studentId, idempotencyKey: "operation-three" }),
    /already been used or is being processed/,
  );
});

test("concurrent Redis QR-ticket claims have exactly one winner across API instances", async (t) => {
  if (!(await ensureRedis(t))) return;

  const studentId = "redis-race-student-" + crypto.randomUUID();
  const validationId = await createTicket(studentId);
  const candidates = ["race-operation-a", "race-operation-b"];
  const results = await Promise.allSettled(candidates.map((idempotencyKey) =>
    claimQrValidationTicket({ validationId, studentId, idempotencyKey })
  ));
  const winners = results.map((result, index) => result.status === "fulfilled" ? index : -1).filter((index) => index >= 0);
  assert.equal(winners.length, 1, "atomic Redis claim must grant exactly one concurrent operation");
  const winner = candidates[winners[0]];
  const loser = candidates[1 - winners[0]];
  assert.match(results[1 - winners[0]].reason.message, /already been used or is being processed/);

  assert.equal(await finalizeQrValidationTicket({ validationId, idempotencyKey: winner }), true);
  await assert.rejects(
    claimQrValidationTicket({ validationId, studentId, idempotencyKey: loser }),
    /already been used or is being processed/,
  );
});
