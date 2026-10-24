'use strict';

const multer = require('multer');
const sharp = require('sharp');
const AppError = require('../../utils/AppError');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 12_000_000;
const MAX_DIMENSION = 8192;
const MAX_NORMALIZED_BYTES = 2 * 1024 * 1024;
const MIME_FORMAT = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

function detectMime(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 5, fields: 3, parts: 8, fieldNameSize: 100, fieldSize: 2048 },
    fileFilter(_req, file, callback) {
        if (!Object.hasOwn(MIME_FORMAT, file.mimetype)) return callback(new AppError('Only JPEG, PNG and WebP frames are allowed', 415));
        return callback(null, true);
    }
});

async function validateFrameBytes(req, _res, next) {
    try {
        if (!Array.isArray(req.files) || req.files.length !== 5) throw new AppError('Exactly five liveness frames are required', 400);
        for (const file of req.files) {
            const detected = detectMime(file.buffer);
            if (!detected || detected !== file.mimetype) throw new AppError('A liveness frame is not a valid image of its declared type', 415);
            let metadata;
            try {
                metadata = await sharp(file.buffer, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true }).metadata();
            } catch {
                throw new AppError('A liveness frame is malformed or exceeds image limits', 415);
            }
            if (metadata.format !== MIME_FORMAT[detected]) throw new AppError('A liveness frame format is invalid', 415);
            if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_PIXELS) {
                throw new AppError('A liveness frame exceeds the permitted dimensions', 413);
            }
            if (Number.isFinite(metadata.pages) && metadata.pages > 1) throw new AppError('Animated images are not valid liveness frames', 415);
            let normalized;
            try {
                normalized = await sharp(file.buffer, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true })
                    .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
            } catch {
                throw new AppError('Unable to normalize a liveness frame', 415);
            }
            if (!normalized.length) throw new AppError('A liveness frame is empty', 415);
            if (normalized.length > MAX_NORMALIZED_BYTES) throw new AppError('A normalized liveness frame exceeds the size limit', 413);
            file.buffer = normalized;
            file.mimetype = 'image/jpeg';
            file.size = normalized.length;
        }
        return next();
    } catch (error) {
        return next(error);
    }
}

module.exports = upload;
module.exports.validateFrameBytes = validateFrameBytes;
