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
    [20, 30], [120, 30], [70, 60], [40, 90], [100, 90],
  ];
  const left = [
    [20, 30], [120, 30], [50, 60], [40, 90], [100, 90],
  ];
  const right = [
    [20, 30], [120, 30], [90, 60], [40, 90], [100, 90],
  ];
  const up = [
    [20, 14], [120, 14], [70, 44], [40, 74], [100, 74],
  ];
  const down = [
    [20, 46], [120, 46], [70, 76], [40, 106], [100, 106],
  ];

  const landmarksFor = (name) => {
    if (name === "CENTER") return center;
    if (name === "TURN_LEFT") return left;
    if (name === "TURN_RIGHT") return right;
    if (name === "MOVE_UP") return up;
    if (name === "MOVE_DOWN") return down;
    return center;
  };

  test("active sequence binds user/session, checks five randomized motion frames, creates one assertion and rejects replay", {
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
    t.mock.method(provider, "detect", async ({ imageBuffer, userId: requestedUserId }) => {
      detectionCalls += 1;
      const frameName = imageBuffer.toString("utf8");
      if (frameName === "SWAPPED_FACE") {
        return {
          landmarks: landmarksFor("CENTER"),
          livenessPassed: true,
          identityVerified: false,
          providerUserId: String(otherUserId),
          identitySimilarity: 0.97,
          identityVerificationId: "identity-" + crypto.randomUUID(),
        };
      }
      return {
        landmarks: landmarksFor(frameName),
        livenessPassed: true,
        livenessScore: 0.99,
        identityVerified: true,
        providerUserId: String(requestedUserId),
        identitySimilarity: 0.98,
        identityVerificationId: "identity-" + crypto.randomUUID(),
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
    assert.equal(verified.livenessMode, "ACTIVE_SEQUENCE_V2");
    assert.equal(detectionCalls, 5, "all five frames must be analyzed for face, passive PAD and identity");
    assert.equal(verificationCalls, 0, "identity verification is part of each frame's combined provider check");

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
    assert.equal(detectionCalls, 5, "replay must not call the provider again");

    // A new person's face may pass passive PAD and even perform the requested
    // motion; identity must be checked on every frame, not only frame zero.
    const switchedFaceChallenge = await biometricService.createActiveChallenge({ userId, sessionId });
    challengeIds.push(switchedFaceChallenge.challengeId);
    const switchedFaceFrames = switchedFaceChallenge.steps.map(({ step }) => ({
      imageBuffer: Buffer.from(step),
      mimeType: "image/jpeg",
    }));
    switchedFaceFrames[2] = { imageBuffer: Buffer.from("SWAPPED_FACE"), mimeType: "image/jpeg" };
    const callsBeforeSwitch = detectionCalls;
    await assert.rejects(
      biometricService.verifyActiveSequence({
        userId,
        sessionId,
        challengeId: switchedFaceChallenge.challengeId,
        challenge: switchedFaceChallenge.challenge,
        frames: switchedFaceFrames,
      }),
      (error) => error.statusCode === 401 && /same enrolled face/i.test(error.message),
    );
    assert.equal(detectionCalls, callsBeforeSwitch + 3, "the identity switch must be rejected as soon as that frame is checked");

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
    assert.equal(verificationCalls, 0, "failed movement sequence must not issue a separate identity request");

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
