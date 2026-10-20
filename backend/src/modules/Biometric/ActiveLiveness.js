'use strict';

const AppError = require('../../utils/AppError');

// InsightFace's five-point landmark order: left eye, right eye, nose,
// left mouth corner, right mouth corner. The ratio is scale-independent.
function normalizeLandmarks(raw) {
    let points = raw;
    if (points && !Array.isArray(points)) {
        if (Array.isArray(points.points)) points = points.points;
        else if (Array.isArray(points.landmarks)) points = points.landmarks;
        else {
            const named = [points.left_eye || points.leftEye || points.eye_left, points.right_eye || points.rightEye || points.eye_right, points.nose || points.nose_tip, points.left_mouth || points.leftMouth || points.mouth_left, points.right_mouth || points.rightMouth || points.mouth_right];
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

function measureYawOffset(rawLandmarks) {
    const points = normalizeLandmarks(rawLandmarks);
    const leftEyeX = points[0].x;
    const rightEyeX = points[1].x;
    const noseX = points[2].x;
    const eyeDistance = Math.abs(rightEyeX - leftEyeX);
    if (!Number.isFinite(eyeDistance) || eyeDistance < 1) {
        throw new AppError('Face angle could not be estimated from the provided image', 401);
    }
    return (noseX - ((leftEyeX + rightEyeX) / 2)) / eyeDistance;
}

function assertActiveSequence(steps, frameLandmarks) {
    if (!Array.isArray(steps) || steps.length !== 3 || !Array.isArray(frameLandmarks) || frameLandmarks.length !== 3) {
        throw new AppError('Exactly three ordered liveness frames are required', 400);
    }
    if (steps[0] !== 'CENTER' || !steps.slice(1).includes('TURN_LEFT') || !steps.slice(1).includes('TURN_RIGHT')) {
        throw new AppError('Active liveness challenge is invalid', 500);
    }
    const centerMax = Number(process.env.ACTIVE_LIVENESS_CENTER_MAX_OFFSET) || 0.10;
    const turnMin = Number(process.env.ACTIVE_LIVENESS_TURN_MIN_OFFSET) || 0.14;
    const offsets = frameLandmarks.map(measureYawOffset);
    if (Math.abs(offsets[0]) > centerMax) {
        throw new AppError('Keep your face facing forward for the first frame', 401);
    }
    for (let i = 1; i < steps.length; i++) {
        if (steps[i] === 'TURN_LEFT' && offsets[i] > -turnMin) {
            throw new AppError('The requested left-turn movement was not detected', 401);
        }
        if (steps[i] === 'TURN_RIGHT' && offsets[i] < turnMin) {
            throw new AppError('The requested right-turn movement was not detected', 401);
        }
    }
    return { yawOffsets: offsets, version: 'ACTIVE_SEQUENCE_V1' };
}

module.exports = { normalizeLandmarks, measureYawOffset, assertActiveSequence };
