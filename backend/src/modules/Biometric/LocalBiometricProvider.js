const AppError =
    require("../../utils/AppError");


const request =
    async ({
        path,
        method = "GET",
        body,
        headers = {}
    }) => {

        const baseUrl = process.env.BIOMETRIC_BASE_URL;
        const apiKey = process.env.BIOMETRIC_API_KEY;
        const timeoutMs = Number(process.env.BIOMETRIC_TIMEOUT_MS) || 5000;
        if (!baseUrl || !apiKey) {
            throw new AppError("Biometric provider is not configured", 503);
        }

        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () => controller.abort(),
                timeoutMs
            );

        try {

            const response =
                await fetch(
                    `${baseUrl}${path}`,
                    {
                        method,

                        headers: {
                            Authorization:
                                `Bearer ${apiKey}`,

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
                    `${process.env.BIOMETRIC_COLLECTION_ID || "students"}/persons`,

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
                    `${process.env.BIOMETRIC_COLLECTION_ID || "students"}/search`,

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


/**
 * Detect exactly one live face and return five-point landmarks for a single
 * frame. Requires the InsightFace Server liveness addon to be enabled.
 */
exports.detect = async ({ imageBuffer, mimeType }) => {
    if (!Buffer.isBuffer(imageBuffer)) throw new AppError('Biometric frame is required', 400);
    const form = new FormData();
    form.append('image', new Blob([imageBuffer], { type: mimeType || 'image/jpeg' }), 'liveness-frame.jpg');
    form.append('max_faces', '2');
    form.append('collection_id', process.env.BIOMETRIC_COLLECTION_ID || 'students');
    const result = await request({ path: '/v1/detect', method: 'POST', body: form });
    if (!Array.isArray(result?.faces) || result.faces.length !== 1) {
        throw new AppError('Each active liveness frame must contain exactly one face', 401);
    }
    const face = result.faces[0];
    const liveness = face?.liveness;
    if (!liveness) throw new AppError('Biometric provider did not evaluate liveness for a frame', 502);
    if (liveness.status !== 'ok' || liveness.is_live !== true) throw new AppError('A liveness frame failed the provider PAD check', 401);
    const liveScore = Number(liveness.live_score);
    if (!Number.isFinite(liveScore) || liveScore < 0 || liveScore > 1) throw new AppError('Biometric provider returned an invalid liveness score', 502);
    const ActiveLiveness = require('./ActiveLiveness');
    return {
        livenessPassed: true,
        livenessScore: liveScore,
        landmarks: ActiveLiveness.normalizeLandmarks(face.landmarks || face.keypoints)
    };
};


exports.deletePerson = async ({ providerUserId }) => {
    if (!providerUserId || typeof providerUserId !== "string") {
        throw new AppError("Biometric provider person identifier is required", 400);
    }

    try {
        await request({
            path: "/v1/collections/" +
                encodeURIComponent(process.env.BIOMETRIC_COLLECTION_ID || "students") +
                "/persons/" + encodeURIComponent(providerUserId),
            method: "DELETE"
        });
        return { deleted: true };
    } catch (error) {
        // A missing provider person is already in the desired deleted state.
        if (Number(error.statusCode) === 404) return { deleted: true, alreadyMissing: true };
        throw error;
    }
};
