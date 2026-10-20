'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLandmarks, measureYawOffset, assertActiveSequence } = require('../src/modules/Biometric/ActiveLiveness');

function points(noseX = 50) {
    return [[10, 20], [90, 20], [noseX, 45], [25, 70], [75, 70]];
}

test('normalizes the documented five-point array and computes a scale-independent centered yaw offset', () => {
    assert.equal(normalizeLandmarks(points()).length, 5);
    assert.equal(measureYawOffset(points()), 0);
});

test('accepts a center-left-right challenge with landmark movement', () => {
    const result = assertActiveSequence(['CENTER', 'TURN_LEFT', 'TURN_RIGHT'], [points(50), points(35), points(65)]);
    assert.equal(result.version, 'ACTIVE_SEQUENCE_V1');
    assert.ok(result.yawOffsets[1] < -0.14);
    assert.ok(result.yawOffsets[2] > 0.14);
});

test('accepts the randomized center-right-left order', () => {
    const result = assertActiveSequence(['CENTER', 'TURN_RIGHT', 'TURN_LEFT'], [points(50), points(65), points(35)]);
    assert.ok(result.yawOffsets[1] > 0.14);
    assert.ok(result.yawOffsets[2] < -0.14);
});

test('rejects repeated centered still images instead of treating them as active liveness', () => {
    assert.throws(() => assertActiveSequence(['CENTER', 'TURN_LEFT', 'TURN_RIGHT'], [points(50), points(50), points(50)]), /left-turn movement/i);
});

test('rejects a wrong direction for a requested action', () => {
    assert.throws(() => assertActiveSequence(['CENTER', 'TURN_LEFT', 'TURN_RIGHT'], [points(50), points(65), points(35)]), /left-turn movement/i);
});

test('fails closed on malformed or incomplete landmarks', () => {
    assert.throws(() => normalizeLandmarks([[1, 2]]), /incomplete/i);
    assert.throws(() => measureYawOffset([[1, 2], [1, 2], [1, 4], [1, 5], [1, 6]]), /could not be estimated/i);
});
