
const { test } = require("node:test");
const assert = require("node:assert/strict");

const sharp = require("sharp");

const upload = require("../src/modules/Biometric/BiometricUpload");

const {
    detectImageMimeType,
    validateImageBytes
} = upload;

async function createImage(format, width = 16, height = 16) {
    const image = sharp({
        create: {
            width,
            height,
            channels: 3,
            background: {
                r: 60,
                g: 100,
                b: 150
            }
        }
    });

    return image[format]().toBuffer();
}

function createRequest(buffer, mimetype) {
    return {
        file: {
            buffer,
            mimetype,
            size: buffer.length
        }
    };
}

function validateRequest(req) {
    return new Promise((resolve) => {
        validateImageBytes(req, {}, (error) => {
            resolve(error || null);
        });
    });
}

function assertHttpStatus(expectedStatus) {
    return (error) => {
        assert.equal(error.statusCode, expectedStatus);
        return true;
    };
}

test("recognizes JPEG by its signature", async () => {
    const buffer = await createImage("jpeg");

    assert.equal(
        detectImageMimeType(buffer),
        "image/jpeg"
    );
});

test("recognizes PNG by its signature", async () => {
    const buffer = await createImage("png");

    assert.equal(
        detectImageMimeType(buffer),
        "image/png"
    );
});

test("recognizes WebP by its signature", async () => {
    const buffer = await createImage("webp");

    assert.equal(
        detectImageMimeType(buffer),
        "image/webp"
    );
});

test("rejects arbitrary bytes labelled as JPEG", async () => {
    const req = createRequest(
        Buffer.from("this is not an image"),
        "image/jpeg"
    );

    const error = await validateRequest(req);

    assert.equal(error.statusCode, 415);
});

test("rejects content whose signature conflicts with MIME type", async () => {
    const req = createRequest(
        await createImage("png"),
        "image/jpeg"
    );

    const error = await validateRequest(req);

    assert.equal(error.statusCode, 415);
    assert.match(error.message, /does not match/i);
});

test("accepts and normalizes a valid JPEG", async () => {
    const req = createRequest(
        await createImage("jpeg"),
        "image/jpeg"
    );

    const error = await validateRequest(req);

    assert.equal(error, null);
    assert.equal(req.file.detectedMimeType, "image/jpeg");
    assert.equal(req.file.mimetype, "image/jpeg");

    const metadata = await sharp(req.file.buffer).metadata();

    assert.equal(metadata.format, "jpeg");
    assert.ok(metadata.width > 0);
    assert.ok(metadata.height > 0);
});

test("normalizes a valid PNG to JPEG", async () => {
    const req = createRequest(
        await createImage("png"),
        "image/png"
    );

    const error = await validateRequest(req);

    assert.equal(error, null);
    assert.equal(req.file.detectedMimeType, "image/png");
    assert.equal(req.file.originalMimeType, "image/png");
    assert.equal(req.file.mimetype, "image/jpeg");

    const metadata = await sharp(req.file.buffer).metadata();

    assert.equal(metadata.format, "jpeg");
});

test("normalizes a valid WebP to JPEG", async () => {
    const req = createRequest(
        await createImage("webp"),
        "image/webp"
    );

    const error = await validateRequest(req);

    assert.equal(error, null);
    assert.equal(req.file.detectedMimeType, "image/webp");
    assert.equal(req.file.mimetype, "image/jpeg");
});

test("rejects malformed bytes even if they have a JPEG signature", async () => {
    const malformed = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
        0x11, 0x22, 0x33, 0x44
    ]);

    const req = createRequest(malformed, "image/jpeg");

    const error = await validateRequest(req);

    assert.equal(error.statusCode, 415);
});

test("rejects images exceeding the decoded pixel limit", async () => {
    // The solid-color PNG compresses well, but decodes to 16 million pixels.
    const req = createRequest(
        await createImage("png", 4000, 4000),
        "image/png"
    );

    const error = await validateRequest(req);

    assert.equal(error.statusCode, 413);
});

test("passes missing files to the controller's existing validation", async () => {
    const error = await validateRequest({});

    assert.equal(error, null);
});

test("returns no detected MIME type for non-Buffer input", () => {
    assert.equal(
        detectImageMimeType("image/jpeg"),
        null
    );
});
