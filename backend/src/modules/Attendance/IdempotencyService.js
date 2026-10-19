const crypto = require("crypto");

const Idempotency =
    require("../../models/Idempotency.model");

const AppError =
    require("../../utils/AppError");

const LEASE_MS =
    (Number(process.env.IDEMPOTENCY_LEASE_SECONDS) || 30) *
    1000;



function normalizeNumber(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
}

function normalizeTimestamp(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime())
        ? String(value)
        : date.toISOString();
}

const createFingerprint = ({
    studentId,
    sessionId,
    token,
    deviceId,
    deviceSignature,
    biometricAssertionId,
    latitude,
    longitude,
    accuracyMeters,
    capturedAt
}) => {
    const request = {
        version: 2,
        studentId: String(studentId),
        sessionId: String(sessionId),
        token: String(token ?? ""),
        deviceId: String(deviceId ?? ""),
        deviceSignature: String(deviceSignature ?? ""),
        biometricAssertionId: String(biometricAssertionId ?? ""),
        latitude: normalizeNumber(latitude),
        longitude: normalizeNumber(longitude),
        accuracyMeters: normalizeNumber(accuracyMeters),
        capturedAt: normalizeTimestamp(capturedAt)
    };

    return crypto
        .createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex");
};



exports.getIdempotencyResult = async (request) => {
    const { key } = request;

    const record = await Idempotency.findOne({ key });

    if (!record) {
        return null;
    }

    const fingerprint = createFingerprint(request);

    if (record.fingerprint !== fingerprint) {
        throw new AppError(
            "Idempotency key was reused for a different request",
            409
        );
    }

    if (record.status === "COMPLETED") {
        return {
            replayed: true,
            responseStatus: record.responseStatus,
            responseBody: record.responseBody
        };
    }

    if (
        record.status === "PROCESSING" &&
        record.leaseUntil &&
        new Date(record.leaseUntil) > new Date()
    ) {
        throw new AppError(
            "This request is already being processed",
            409
        );
    }

    // An expired PROCESSING lease may be reclaimed by claimIdempotency.
    return null;
};

exports.createFingerprint = createFingerprint;




exports.claimIdempotency = async (request) => {
    const {
        key,
        studentId,
        sessionId
    } = request;

    const fingerprint = createFingerprint(request);

    const ownerToken = crypto.randomUUID();
    const now = new Date();

    const leaseUntil = new Date(
        now.getTime() + LEASE_MS
    );


    /*
    --------------------------------------------------
    FIRST ATOMIC CLAIM
    --------------------------------------------------
    */

    let record;

    try {

        record =
            await Idempotency.findOneAndUpdate(
                {
                    key
                },
                {
                    $setOnInsert: {
                        key,
                        fingerprint,
                        studentId,
                        sessionId,
                        status: "PROCESSING",
                        ownerToken,
                        leaseUntil
                    }
                },
                {
                    upsert: true,
                    returnDocument: "after",
                }
            );

    } catch (error) {

        /*
         * Another request may have inserted
         * the same key at exactly the same time.
         */

        if (error.code !== 11000) {
            throw error;
        }

        record =
            await Idempotency.findOne({
                key
            });
    }


    if (!record) {
        throw new AppError(
            "Unable to create idempotency record",
            500
        );
    }


    /*
    --------------------------------------------------
    REQUEST FINGERPRINT
    --------------------------------------------------
    */

    if (
        record.fingerprint !==
        fingerprint
    ) {

        throw new AppError(
            "Idempotency key was reused for a different request",
            409
        );
    }


    /*
    --------------------------------------------------
    COMPLETED REQUEST
    --------------------------------------------------
    */

    if (
        record.status ===
        "COMPLETED"
    ) {

        return {
            replayed: true,
            responseStatus:
                record.responseStatus,
            responseBody:
                record.responseBody
        };
    }


    /*
    --------------------------------------------------
    WE OWN THIS REQUEST
    --------------------------------------------------
    */

    if (
        record.ownerToken ===
        ownerToken
    ) {

        return {
            replayed: false,
            ownerToken
        };
    }


    /*
    --------------------------------------------------
    REQUEST STILL PROCESSING
    --------------------------------------------------
    */

    if (
        record.leaseUntil &&
        record.leaseUntil > now
    ) {

        throw new AppError(
            "This request is already being processed",
            409
        );
    }


    /*
    --------------------------------------------------
    OLD LEASE EXPIRED
    --------------------------------------------------
    */

    const reclaimed =
        await Idempotency.findOneAndUpdate(
            {
                key,
                status: "PROCESSING",
                fingerprint,
                leaseUntil: {
                    $lte: now
                }
            },
            {
                $set: {
                    ownerToken,
                    leaseUntil
                }
            },
            {
                returnDocument: "after",
            }
        );


    if (!reclaimed) {

        const latest =
            await Idempotency.findOne({
                key
            });

        if (
            latest &&
            latest.status ===
            "COMPLETED"
        ) {

            return {
                replayed: true,
                responseStatus:
                    latest.responseStatus,
                responseBody:
                    latest.responseBody
            };
        }

        throw new AppError(
            "This request is already being processed",
            409
        );
    }


    return {
        replayed: false,
        ownerToken
    };
};


exports.completeIdempotency = async ({
    key,
    ownerToken,
    responseStatus,
    responseBody,
    dbSession
}) => {
    const options = dbSession
        ? { session: dbSession }
        : {};

    const result = await Idempotency.updateOne(
        {
            key,
            ownerToken,
            status: "PROCESSING"
        },
        {
            $set: {
                status: "COMPLETED",
                responseStatus,
                responseBody
            },
            $unset: {
                ownerToken: "",
                leaseUntil: ""
            }
        },
        options
    );

    if (result.matchedCount !== 1) {
        throw new AppError(
            "Idempotency ownership was lost",
            409
        );
    }
};
