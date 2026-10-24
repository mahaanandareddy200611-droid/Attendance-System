'use strict';

const AppError = require('../../utils/AppError');

function normalizeLandmarks(raw) {
    let points = raw;
    if (points && !Array.isArray(points)) {
        if (Array.isArray(points.points)) points = points.points;
        else if (Array.isArray(points.landmarks)) points = points.landmarks;
        else {
            const named = [
                points.left_eye || points.leftEye || points.eye_left,
                points.right_eye || points.rightEye || points.eye_right,
                points.nose || points.nose_tip,
                points.left_mouth || points.leftMouth || points.mouth_left,
                points.right_mouth || points.rightMouth || points.mouth_right
            ];
            if (named.every(Boolean)) points = named;
        }
    }
    if (!Array.isArray(points)) throw new AppError('Biometric provider did not return usable face landmarks', 502);
    if (points.length >= 10 && typeof points[0] === 'number') {
        const flattened = points;
        points = [];
        for (let i = 0; i < 10; i += 2) points.push([flattened[i], flattened[i + 1]]);
    }
    if (points.length < 5) throw new AppError('Biometric provider returned incomplete face landmarks', 502);
    const normalized = points.slice(0, 5).map((point) => {
        if (Array.isArray(point) && point.length >= 2) return { x: Number(point[0]), y: Number(point[1]) };
        if (point && typeof point === 'object') return { x: Number(point.x ?? point[0]), y: Number(point.y ?? point[1]) };
        return { x: NaN, y: NaN };
    });
    if (normalized.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        throw new AppError('Biometric provider returned invalid face landmarks', 502);
    }
    return normalized;
}

function eyeDistance(points) {
    const distance = Math.abs(points[1].x - points[0].x);
    if (!Number.isFinite(distance) || distance < 1) {
        throw new AppError('Face movement could not be estimated from the provided image', 401);
    }
    return distance;
}

function measureYawOffset(rawLandmarks) {
    const points = normalizeLandmarks(rawLandmarks);
    return (points[2].x - ((points[0].x + points[1].x) / 2)) / eyeDistance(points);
}

function measureVerticalPosition(rawLandmarks) {
    const points = normalizeLandmarks(rawLandmarks);
    return points[2].y / eyeDistance(points);
}

function assertActiveSequence(steps, frameLandmarks) {
    const requiredMovements = ['MOVE_DOWN', 'MOVE_UP', 'TURN_LEFT', 'TURN_RIGHT'];
    if (!Array.isArray(steps) || steps.length !== 5 || !Array.isArray(frameLandmarks) || frameLandmarks.length !== 5) {
        throw new AppError('Exactly five ordered liveness frames are required', 400);
    }
    const movements = steps.slice(1).slice().sort();
    if (steps[0] !== 'CENTER' || JSON.stringify(movements) !== JSON.stringify(requiredMovements)) {
        throw new AppError('Active liveness challenge is invalid', 500);
    }

    const centerMax = Number(process.env.ACTIVE_LIVENESS_CENTER_MAX_OFFSET) || 0.25;
    const turnMin = Number(process.env.ACTIVE_LIVENESS_TURN_MIN_OFFSET) || 0.12;
    const verticalMin = Number(process.env.ACTIVE_LIVENESS_VERTICAL_MIN_OFFSET) || 0.12;
    const yawOffsets = frameLandmarks.map(measureYawOffset);
    const verticalPositions = frameLandmarks.map(measureVerticalPosition);
    if (Math.abs(yawOffsets[0]) > centerMax) {
        throw new AppError('Center your face and look straight ahead for the first frame', 401);
    }

    for (let i = 1; i < steps.length; i++) {
        const yawChange = yawOffsets[i] - yawOffsets[0];
        const verticalChange = verticalPositions[i] - verticalPositions[0];
        // The test fixtures and unmirrored image coordinates define TURN_LEFT as
        // a negative nose-x offset and TURN_RIGHT as a positive nose-x offset.
        // Keep these signs consistent with the uploaded frame coordinates.
        if (steps[i] === 'TURN_LEFT' && yawChange > -turnMin) {
            throw new AppError('Left movement was not detected. Follow the ← arrow, turn your head to your left, and hold briefly until the countdown finishes.', 401);
        }
        if (steps[i] === 'TURN_RIGHT' && yawChange < turnMin) {
            throw new AppError('Right movement was not detected. Follow the → arrow, turn your head to your right, and hold briefly until the countdown finishes.', 401);
        }
        if (steps[i] === 'MOVE_UP' && verticalChange > -verticalMin) {
            throw new AppError('Upward movement was not detected. Follow the ↑ arrow and move your face slightly upward inside the preview.', 401);
        }
        if (steps[i] === 'MOVE_DOWN' && verticalChange < verticalMin) {
            throw new AppError('Downward movement was not detected. Follow the ↓ arrow and move your face slightly downward inside the preview.', 401);
        }
    }
    return {
        yawOffsets,
        verticalOffsets: verticalPositions.map((value) => value - verticalPositions[0]),
        version: 'ACTIVE_SEQUENCE_V2'
    };
}

module.exports = { normalizeLandmarks, measureYawOffset, measureVerticalPosition, assertActiveSequence };
