
const multer = require("multer");
const sharp = require("sharp");
const AppError = require("../../utils/AppError");

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_FIELD_SIZE_BYTES = 2 * 1024;

const MAX_IMAGE_PIXELS = 12_000_000;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_NORMALIZED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_DIMENSION = 1600;

const MIME_TO_FORMAT = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp"
};

const ALLOWED_IMAGE_TYPES = new Set(
    Object.keys(MIME_TO_FORMAT)
);

function detectImageMimeType(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        return null;
    }

    // JPEG signature: FF D8 FF
    if (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
    ) {
        return "image/jpeg";
    }

    // PNG signature
    const pngSignature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47,
        0x0d, 0x0a, 0x1a, 0x0a
    ]);

    if (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(pngSignature)
    ) {
        return "image/png";
    }

    // WebP signature: RIFF....WEBP
    if (
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
        return "image/webp";
    }

    return null;
}

/**
 * Sharp can reject an image for exceeding its pixel limit
 * before our own dimension checks run.
 */
function isPixelLimitError(error) {
    const message = String(error?.message || "");

    return /pixel limit|limit.*pixel|too many pixels/i.test(
        message
    );
}

function createDecodeError(error) {
    if (isPixelLimitError(error)) {
        return new AppError(
            "Image dimensions exceed the permitted pixel limit",
            413
        );
    }

    return new AppError(
        "Image is malformed or cannot be decoded",
        415
    );
}

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
        files: 1,
        fields: 4,
        parts: 5,
        fieldNameSize: 100,
        fieldSize: MAX_FIELD_SIZE_BYTES
    },

    fileFilter(req, file, callback) {
        if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
            return callback(
                new AppError(
                    "Only JPEG, PNG and WebP images are allowed",
                    415
                )
            );
        }

        return callback(null, true);
    }
});

async function validateImageBytes(req, res, next) {
    if (!req.file) {
        return next();
    }

    try {
        const sourceBuffer = req.file.buffer;

        const detectedMimeType =
            detectImageMimeType(sourceBuffer);

        if (!detectedMimeType) {
            throw new AppError(
                "Uploaded file is not a supported image",
                415
            );
        }

        if (detectedMimeType !== req.file.mimetype) {
            throw new AppError(
                "Image content does not match its declared file type",
                415
            );
        }

        const decoderOptions = {
            failOn: "warning",
            limitInputPixels: MAX_IMAGE_PIXELS,
            sequentialRead: true
        };

        let metadata;

        try {
            metadata = await sharp(
                sourceBuffer,
                decoderOptions
            ).metadata();
        } catch (error) {
            throw createDecodeError(error);
        }

        if (
            metadata.format !== MIME_TO_FORMAT[detectedMimeType]
        ) {
            throw new AppError(
                "Decoded image format does not match its content",
                415
            );
        }

        const { width, height } = metadata;

        if (
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0
        ) {
            throw new AppError(
                "Image dimensions are invalid",
                415
            );
        }

        if (
            width > MAX_IMAGE_DIMENSION ||
            height > MAX_IMAGE_DIMENSION ||
            width * height > MAX_IMAGE_PIXELS
        ) {
            throw new AppError(
                "Image dimensions exceed the permitted pixel limit",
                413
            );
        }

        if (
            Number.isFinite(metadata.pages) &&
            metadata.pages > 1
        ) {
            throw new AppError(
                "Animated or multi-page images are not supported",
                415
            );
        }

        let normalizedBuffer;

        try {
            normalizedBuffer = await sharp(
                sourceBuffer,
                decoderOptions
            )
                .rotate()
                .resize({
                    width: MAX_OUTPUT_DIMENSION,
                    height: MAX_OUTPUT_DIMENSION,
                    fit: "inside",
                    withoutEnlargement: true
                })
                .jpeg({
                    quality: 82,
                    mozjpeg: true
                })
                .toBuffer();
        } catch (error) {
            throw createDecodeError(error);
        }

        if (normalizedBuffer.length === 0) {
            throw new AppError(
                "Decoded image is empty",
                415
            );
        }

        if (
            normalizedBuffer.length >
            MAX_NORMALIZED_IMAGE_BYTES
        ) {
            throw new AppError(
                "Processed image exceeds the permitted size",
                413
            );
        }

        // Both enrollment and verification now receive normalized JPEG.
        req.file.originalMimeType = detectedMimeType;
        req.file.detectedMimeType = detectedMimeType;
        req.file.buffer = normalizedBuffer;
        req.file.mimetype = "image/jpeg";
        req.file.size = normalizedBuffer.length;

        return next();
    } catch (error) {
        if (error instanceof AppError) {
            return next(error);
        }

        return next(
            new AppError(
                "Unable to validate uploaded image",
                415
            )
        );
    }
}

module.exports = upload;
module.exports.validateImageBytes = validateImageBytes;
module.exports.detectImageMimeType = detectImageMimeType;
