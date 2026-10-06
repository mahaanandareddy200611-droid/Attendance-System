const crypto = require("crypto");

const Idempotency =
    require("./Idempotency.model");

const AppError =
    require("../../utils/AppError");

const LEASE_MS =
    (Number(process.env.IDEMPOTENCY_LEASE_SECONDS) || 30) *
    1000;


const createFingerprint = ({
    studentId,
    token
}) => {

    return crypto
        .createHash("sha256")
        .update(
            `${String(studentId)}:${token}`
        )
        .digest("hex");
};


exports.claimIdempotency = async ({
    key,
    studentId,
    sessionId,
    token
}) => {

    const fingerprint =
        createFingerprint({
            studentId,
            token
        });

    const ownerToken =
        crypto.randomUUID();

    const now = new Date();

    const leaseUntil =
        new Date(
            now.getTime() +
            LEASE_MS
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
                    new: true
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
                new: true
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


exports.completeIdempotency =
    async ({
        key,
        ownerToken,
        responseStatus,
        responseBody
    }) => {

        const result =
            await Idempotency.updateOne(
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
                }
            );

        if (
            result.matchedCount !== 1
        ) {

            throw new AppError(
                "Idempotency ownership was lost",
                409
            );
        }
    };