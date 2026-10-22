
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const testRedisUrl = process.env.TEST_REDIS_URL;

if (!testRedisUrl) {
    test(
        "biometric assertion reservation against real Redis",
        { skip: "Set TEST_REDIS_URL to run the Redis integration test" },
        () => {}
    );
} else {
    // Configure before importing modules that initialize Redis.
    process.env.REDIS_URL = testRedisUrl;

    const { redisClient } = require(
        "../../src/config/redis"
    );

    const {
        reserveAssertion,
        releaseAssertionReservation,
        finalizeAssertionReservation
    } = require(
        "../../src/modules/Biometric/BiometricService"
    );

    test(
        "real Redis enforces single-owner reservation, release and finalization",
        async (t) => {
            if (!redisClient.isOpen) {
                await redisClient.connect();
            }

            const assertionId = crypto.randomUUID();
            const key = `biometric:assertion:${assertionId}`;

            const userId = "integration-student";
            const sessionId = "integration-session";

            const initialAssertion = {
                userId,
                sessionId,
                verificationId: crypto.randomUUID(),
                providerUserId: userId,
                livenessPassed: true,
                faceMatchPassed: true,
                activeLivenessPassed: true,
                livenessMode: "ACTIVE_SEQUENCE_V1",
                similarity: 0.98
            };

            const reserve = (reservationId) =>
                reserveAssertion({
                    assertionId,
                    userId,
                    sessionId,
                    reservationId
                });

            t.after(async () => {
                await redisClient.del(key).catch(() => {});
                if (redisClient.isOpen) {
                    await redisClient.quit().catch(() => {});
                }
            });

            await redisClient.set(
                key,
                JSON.stringify(initialAssertion),
                { PX: 30_000 }
            );

            // Competing callers must not both become owners.
            const competing = await Promise.allSettled([
                reserve("operation-A"),
                reserve("operation-B")
            ]);

            const winners = competing.filter(
                (result) => result.status === "fulfilled"
            );

            const losers = competing.filter(
                (result) => result.status === "rejected"
            );

            assert.equal(winners.length, 1);
            assert.equal(losers.length, 1);

            const winningReservationId =
                winners[0].value.reservationId;

            let stored = JSON.parse(
                await redisClient.get(key)
            );

            assert.equal(stored.state, "RESERVED");
            assert.equal(
                stored.reservationId,
                winningReservationId
            );

            // The same operation can recover its reservation.
            const recovered = await reserve(
                winningReservationId
            );

            assert.equal(
                recovered.reservationId,
                winningReservationId
            );

            // A non-owner cannot release the reservation.
            const wrongRelease =
                await releaseAssertionReservation({
                    assertionId,
                    reservationId: "not-the-owner"
                });

            assert.equal(wrongRelease, false);

            // The owner can release after a confirmed transaction rollback.
            const released =
                await releaseAssertionReservation({
                    assertionId,
                    reservationId: winningReservationId
                });

            assert.equal(released, true);

            stored = JSON.parse(
                await redisClient.get(key)
            );

            assert.equal(stored.reservationId, undefined);
            assert.equal(stored.state, undefined);

            // The released assertion can be reserved by a new operation.
            await reserve("operation-C");

            const finalized =
                await finalizeAssertionReservation({
                    assertionId,
                    reservationId: "operation-C"
                });

            assert.equal(finalized, true);
            assert.equal(await redisClient.get(key), null);

            // Consumed assertions cannot be reserved again.
            await assert.rejects(
                reserve("operation-D"),
                (error) => error.statusCode === 401
            );
        }
    );
}
