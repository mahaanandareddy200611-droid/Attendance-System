"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const mongoUrl = process.env.TEST_MONGO_URL;
const configuredRedisUrl = process.env.TEST_REDIS_URL;

if (!mongoUrl || !configuredRedisUrl) {
  test("active biometric sequence integration", {
    skip: "Set TEST_MONGO_URL and TEST_REDIS_URL to the dedicated integration services",
  }, () => {});
} else {
  const databaseName = decodeURIComponent(new URL(mongoUrl).pathname.slice(1).split("/")[0]);
  if (databaseName !== "attendance_test") {
    throw new Error("Safety check: TEST_MONGO_URL must use attendance_test");
  }

  const isolatedRedisUrl = new URL(configuredRedisUrl);
  isolatedRedisUrl.pathname = "/12";
  process.env.REDIS_URL = isolatedRedisUrl.toString();
  process.env.BIOMETRIC_CHALLENGE_TTL_MS = "30000";
  process.env.BIOMETRIC_ASSERTION_TTL_MS = "30000";

  const mongoose = require("mongoose");
  const { redisClient } = require("../../src/config/redis");
  const BiometricEnrollment = require("../../src/models/BiometricEnrollment.model");
  const biometricService = require("../../src/modules/Biometric/BiometricService");
  const provider = require("../../src/modules/Biometric/LocalBiometricProvider");

  const center = [
    [20, 10], [120, 10], [70, 30], [40, 50], [100, 50],
  ];
  const left = [
    [20, 10], [120, 10], [50, 30], [40, 50], [100, 50],
  ];
  const right = [
    [20, 10], [120, 10], [90, 30], [40, 50], [100, 50],
  ];

  const landmarksFor = (name) => {
    if (name === "CENTER") return center;
    if (name === "TURN_LEFT") return left;
    if (name === "TURN_RIGHT") return right;
    return center;
  };

  test("active sequence binds user/session, checks all three frames, creates one assertion and rejects replay", {
    timeout: 30000,
  }, async (t) => {
    const userId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();
    const sessionId = "active-sequence-" + crypto.randomUUID();
    const challengeIds = [];
    const assertionIds = [];
    let connectedMongo = false;

    t.after(async () => {
      for (const challengeId of challengeIds) {
        await redisClient.del("biometric:active-challenge:" + challengeId).catch(() => {});
      }
      for (const assertionId of assertionIds) {
        await redisClient.del("biometric:assertion:" + assertionId).catch(() => {});
      }
      if (connectedMongo) {
        await BiometricEnrollment.deleteMany({ userId: { $in: [userId, otherUserId] } }).catch(() => {});
        await mongoose.disconnect().catch(() => {});
      }
      if (redisClient.isOpen) await redisClient.quit().catch(() => {});
    });

    await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 10000 });
    connectedMongo = true;
    if (!redisClient.isOpen) await redisClient.connect();

    await BiometricEnrollment.create({
      userId,
      provider: "LOCAL",
      providerUserId: String(userId),
      modelVersion: "active-sequence-integration-test",
      status: "ACTIVE",
    });

    let detectionCalls = 0;
    let verificationCalls = 0;
    t.mock.method(provider, "detect", async ({ imageBuffer }) => {
      detectionCalls += 1;
      return { landmarks: landmarksFor(imageBuffer.toString("utf8")) };
    });
    t.mock.method(provider, "verify", async ({ userId: requestedUserId }) => {
      verificationCalls += 1;
      return {
        verified: true,
        livenessPassed: true,
        faceMatchPassed: true,
        similarity: 0.98,
        verificationId: "verify-" + crypto.randomUUID(),
        providerUserId: String(requestedUserId),
      };
    });

    const challenge = await biometricService.createActiveChallenge({ userId, sessionId });
    challengeIds.push(challenge.challengeId);
    const frames = challenge.steps.map(({ step }) => ({
      imageBuffer: Buffer.from(step),
      mimeType: "image/jpeg",
    }));

    await assert.rejects(
      biometricService.verifyActiveSequence({
        userId: otherUserId,
        sessionId,
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        frames,
      }),
      (error) => error.statusCode === 403,
    );
    await assert.rejects(
      biometricService.verifyActiveSequence({
        userId,
        sessionId: sessionId + "-wrong",
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        frames,
      }),
      (error) => error.statusCode === 403,
    );
    assert.equal(detectionCalls, 0, "wrong user/session must be rejected before provider calls");

    const verified = await biometricService.verifyActiveSequence({
      userId,
      sessionId,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      frames,
    });
    assertionIds.push(verified.assertionId);

    assert.equal(verified.verified, true);
    assert.equal(verified.activeLivenessPassed, true);
    assert.equal(verified.livenessMode, "ACTIVE_SEQUENCE_V1");
    assert.equal(detectionCalls, 3, "all three frames must be analyzed");
    assert.equal(verificationCalls, 1, "identity verification must happen once");

    const assertion = await biometricService.validateAssertion({
      assertionId: verified.assertionId,
      userId,
      sessionId,
    });
    assert.equal(assertion.activeLivenessPassed, true);

    await assert.rejects(
      biometricService.verifyActiveSequence({
        userId,
        sessionId,
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        frames,
      }),
      (error) => error.statusCode === 401,
    );
    assert.equal(detectionCalls, 3, "replay must not call the provider again");

    const badSequenceChallenge = await biometricService.createActiveChallenge({ userId, sessionId });
    challengeIds.push(badSequenceChallenge.challengeId);
    const repeatedCenterFrames = badSequenceChallenge.steps.map(() => ({
      imageBuffer: Buffer.from("CENTER"),
      mimeType: "image/jpeg",
    }));
    await assert.rejects(
      biometricService.verifyActiveSequence({
        userId,
        sessionId,
        challengeId: badSequenceChallenge.challengeId,
        challenge: badSequenceChallenge.challenge,
        frames: repeatedCenterFrames,
      }),
      (error) => error.statusCode === 401,
    );
    assert.equal(verificationCalls, 1, "failed head-turn sequence must not reach identity verification");

    await assert.rejects(
      biometricService.verifyActiveSequence({
        userId,
        sessionId,
        challengeId: badSequenceChallenge.challengeId,
        challenge: badSequenceChallenge.challenge,
        frames,
      }),
      (error) => error.statusCode === 401,
    );
  });
}
