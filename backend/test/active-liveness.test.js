'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLandmarks, measureYawOffset, measureVerticalPosition, assertActiveSequence } = require('../src/modules/Biometric/ActiveLiveness');

function points(noseX = 50, yShift = 0) {
    return [[10, 20 + yShift], [90, 20 + yShift], [noseX, 45 + yShift], [25, 70 + yShift], [75, 70 + yShift]];
}

const fullSteps = ['CENTER', 'TURN_LEFT', 'TURN_RIGHT', 'MOVE_UP', 'MOVE_DOWN'];

test('normalizes five-point landmarks and computes a scale-independent centered yaw offset', () => {
    assert.equal(normalizeLandmarks(points()).length, 5);
    assert.equal(measureYawOffset(points()), 0);
    assert.ok(Number.isFinite(measureVerticalPosition(points())));
});

test('accepts center-relative left, right, up and down movement in a five-frame challenge', () => {
    const result = assertActiveSequence(
        fullSteps,
        [points(50), points(35), points(65), points(50, -14), points(50, 14)]
    );
    assert.equal(result.version, 'ACTIVE_SEQUENCE_V2');
    assert.ok(result.yawOffsets[1] < -0.14);
    assert.ok(result.yawOffsets[2] > 0.14);
    assert.ok(result.verticalOffsets[3] < -0.12);
    assert.ok(result.verticalOffsets[4] > 0.12);
});

test('accepts randomized ordering of all four motion prompts after the center frame', () => {
    const steps = ['CENTER', 'MOVE_DOWN', 'TURN_RIGHT', 'MOVE_UP', 'TURN_LEFT'];
    const result = assertActiveSequence(
        steps,
        [points(50), points(50, 14), points(65), points(50, -14), points(35)]
    );
    assert.ok(result.yawOffsets[2] > 0.12);
    assert.ok(result.yawOffsets[4] < -0.12);
    assert.ok(result.verticalOffsets[1] > 0.12);
    assert.ok(result.verticalOffsets[3] < -0.12);
});

test('rejects repeated centered still images instead of treating them as active liveness', () => {
    assert.throws(
        () => assertActiveSequence(fullSteps, [points(50), points(50), points(50), points(50), points(50)]),
        /left movement was not detected/i
    );
});

test('rejects wrong horizontal direction for the requested arrow', () => {
    assert.throws(
        () => assertActiveSequence(fullSteps, [points(50), points(65), points(35), points(50, -14), points(50, 14)]),
        /left movement was not detected/i
    );
});

test('rejects missing vertical motion in either direction', () => {
    assert.throws(
        () => assertActiveSequence(fullSteps, [points(50), points(35), points(65), points(50), points(50, 14)]),
        /upward movement was not detected/i
    );
    assert.throws(
        () => assertActiveSequence(fullSteps, [points(50), points(35), points(65), points(50, -14), points(50)]),
        /downward movement was not detected/i
    );
});

test('rejects malformed or incomplete landmarks', () => {
    assert.throws(() => normalizeLandmarks([[1, 2]]), /incomplete/i);
    assert.throws(() => measureYawOffset([[1, 2], [1, 2], [1, 4], [1, 5], [1, 6]]), /could not be estimated/i);
});

test('rejects a malformed challenge that omits a required movement', () => {
    assert.throws(
        () => assertActiveSequence(['CENTER', 'TURN_LEFT', 'TURN_RIGHT', 'MOVE_UP', 'MOVE_UP'], [points(50), points(35), points(65), points(50, -14), points(50, -14)]),
        /challenge is invalid/i
    );
});
