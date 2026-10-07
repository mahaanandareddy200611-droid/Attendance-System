const AppError =
    require("../../utils/AppError");


const BASE_URL =
    process.env.BIOMETRIC_BASE_URL;

const API_KEY =
    process.env.BIOMETRIC_API_KEY;

const COLLECTION_ID =
    process.env.BIOMETRIC_COLLECTION_ID ||
    "students";

const TIMEOUT_MS =
    Number(
        process.env.BIOMETRIC_TIMEOUT_MS
    ) || 5000;


if (!BASE_URL) {
    throw new Error(
        "BIOMETRIC_BASE_URL is not configured"
    );
}

if (!API_KEY) {
    throw new Error(
        "BIOMETRIC_API_KEY is not configured"
    );
}


const request =
    async ({
        path,
        method = "GET",
        body,
        headers = {}
    }) => {

        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () => controller.abort(),
                TIMEOUT_MS
            );

        try {

            const response =
                await fetch(
                    `${BASE_URL}${path}`,
                    {
                        method,

                        headers: {
                            Authorization:
                                `Bearer ${API_KEY}`,

                            ...headers
                        },

                        body,

                        signal:
                            controller.signal
                    }
                );


            let data = null;

            try {
                data =
                    await response.json();
            } catch {
                data = null;
            }


            if (!response.ok) {

                const code =
                    data?.error?.code ||
                    data?.code ||
                    "BIOMETRIC_PROVIDER_ERROR";

                const message =
                    data?.error?.message ||
                    data?.message ||
                    "Biometric provider request failed";


                const error =
                    new AppError(
                        message,
                        response.status
                    );

                error.providerCode =
                    code;

                error.providerResponse =
                    data;

                throw error;
            }


            return data;

        } catch (error) {

            if (
                error.name ===
                "AbortError"
            ) {

                throw new AppError(
                    "Biometric provider timeout",
                    504
                );
            }

            throw error;

        } finally {

            clearTimeout(timeout);
        }
    };


/*
--------------------------------------------------
ENROLL STUDENT
--------------------------------------------------
*/

exports.enroll =
    async ({
        userId,
        imageBuffer,
        mimeType
    }) => {

        if (
            !Buffer.isBuffer(
                imageBuffer
            )
        ) {

            throw new AppError(
                "Biometric enrollment image is required",
                400
            );
        }


        const form =
            new FormData();


        /*
         * Use the User ID as the stable
         * InsightFace Person ID.
         */
        form.append(
            "id",
            String(userId)
        );


        form.append(
            "external_id",
            String(userId)
        );


        form.append(
            "review_mode",
            "strict"
        );


        form.append(
            "images",
            new Blob(
                [
                    imageBuffer
                ],
                {
                    type:
                        mimeType ||
                        "image/jpeg"
                }
            ),
            "enrollment.jpg"
        );


        const result =
            await request({
                path:
                    `/v1/collections/` +
                    `${COLLECTION_ID}/persons`,

                method:
                    "POST",

                body:
                    form
            });


        if (
            !result?.person?.id
        ) {

            throw new AppError(
                "Biometric enrollment failed",
                502
            );
        }


        return {
            providerUserId:
                result.person.id,

            acceptedFaces:
                result.faces?.length || 0,

            rejectedImages:
                result.rejected_images || [],

            requestId:
                result.request_id
        };
    };


/*
--------------------------------------------------
VERIFY STUDENT
--------------------------------------------------
*/

exports.verify =
    async ({
        userId,
        imageBuffer,
        mimeType
    }) => {

        if (
            !Buffer.isBuffer(
                imageBuffer
            )
        ) {

            throw new AppError(
                "Biometric verification image is required",
                400
            );
        }


        const form =
            new FormData();


        form.append(
            "image",
            new Blob(
                [
                    imageBuffer
                ],
                {
                    type:
                        mimeType ||
                        "image/jpeg"
                }
            ),
            "verification.jpg"
        );


        form.append(
            "limit",
            "5"
        );


        const threshold =
            process.env
                .BIOMETRIC_MATCH_THRESHOLD ||
            "0.40";


        form.append(
            "threshold",
            threshold
        );


        const result =
            await request({
                path:
                    `/v1/collections/` +
                    `${COLLECTION_ID}/search`,

                method:
                    "POST",

                body:
                    form
            });


        /*
         * Liveness must have been evaluated.
         */
        const liveness =
            result?.searched_face
                ?.liveness;


        if (
            !liveness
        ) {

            throw new AppError(
                "Biometric liveness was not evaluated",
                502
            );
        }


        if (
            liveness.status !==
            "ok" ||
            liveness.is_live !==
            true
        ) {

            throw new AppError(
                "Liveness verification failed",
                401
            );
        }


        const matches =
            result?.matches || [];


        if (
            matches.length === 0
        ) {

            throw new AppError(
                "Face does not match an enrolled student",
                401
            );
        }


        const bestMatch =
            matches[0];


        const matchedUserId =
            bestMatch
                ?.person
                ?.external_id;


        if (
            String(
                matchedUserId
            ) !==
            String(userId)
        ) {

            throw new AppError(
                "Face identity does not match the logged-in student",
                401
            );
        }


        const similarity =
            Number(
                bestMatch.similarity
            );


        const minimumThreshold =
            Number(
                process.env
                    .BIOMETRIC_MATCH_THRESHOLD
            ) || 0.40;


        if (
            !Number.isFinite(
                similarity
            ) ||
            similarity <
                minimumThreshold
        ) {

            throw new AppError(
                "Face similarity is below the configured threshold",
                401
            );
        }


        return {
            verified:
                true,

            livenessPassed:
                true,

            livenessScore:
                liveness.live_score,

            faceMatchPassed:
                true,

            similarity,

            providerUserId:
                matchedUserId,

            verificationId:
                result.request_id
        };
    };