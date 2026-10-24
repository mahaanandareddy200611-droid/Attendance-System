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
        const timeoutMs = Number(process.env.BIOMETRIC_TIMEOUT_MS) || 30000;
        if (!baseUrl || !apiKey) {
            const error = new AppError("Biometric provider is not configured", 503);
            error.publicMessage = "Face verification is temporarily unavailable. Please try again later.";
            error.providerCode = "BIOMETRIC_PROVIDER_NOT_CONFIGURED";
            throw error;
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
                const rawCode = data?.error?.code || data?.code || "BIOMETRIC_PROVIDER_ERROR";
                const code = typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(rawCode)
                    ? rawCode
                    : "BIOMETRIC_PROVIDER_ERROR";
                const rawMessage = String(data?.error?.message || data?.message || "Biometric provider request failed");

                // Do not return upstream 5xx bodies verbatim. These often contain the
                // provider's generic "unexpected error" and hide the actionable cause.
                if (response.status >= 500) {
                    const error = new AppError(
                        "Biometric provider is temporarily unable to process this face image.",
                        503
                    );
                    error.publicMessage = "Face verification could not process the image because the biometric service is temporarily unavailable. Please retry shortly. If this continues, share the request reference with your administrator.";
                    error.providerCode = code;
                    error.providerResponse = data;
                    throw error;
                }

                const error = new AppError(rawMessage, response.status);
                error.providerCode = code;
                error.providerResponse = data;
                throw error;
            }


            return data;

        } catch (error) {
            if (error?.statusCode) throw error;

            if (error?.name === "AbortError") {
                const timeoutError = new AppError("Biometric provider timeout", 504);
                timeoutError.publicMessage = "Face verification is taking too long because the biometric service did not respond. Please retry shortly.";
                timeoutError.providerCode = "BIOMETRIC_PROVIDER_TIMEOUT";
                throw timeoutError;
            }

            if (error instanceof TypeError) {
                const networkError = new AppError("Biometric provider could not be reached", 503);
                networkError.publicMessage = "Face verification could not reach the biometric service. Please retry shortly.";
                networkError.providerCode = "BIOMETRIC_PROVIDER_UNREACHABLE";
                throw networkError;
            }

            throw error;
        } finally {

            clearTimeout(timeout);
        }
    };


/**
 * Verify that the configured provider is reachable and has its model/API
 * initialized. Never treat non-empty environment variables as proof of health.
 */
exports.checkHealth = async () => {
    try {
        const health = await request({ path: "/v1/health" });
        return health?.status === "ready" && health?.auth_enabled === true;
    } catch {
        // Readiness must fail closed without exposing provider URLs or secrets.
        return false;
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


        if (!result?.person?.id) {
            throw new AppError("Biometric enrollment failed", 502);
        }

        const acceptedFaces = Array.isArray(result.faces) ? result.faces.length : 0;
        const rejectedImages = Array.isArray(result.rejected_images) ? result.rejected_images : [];
        if (acceptedFaces !== 1 || rejectedImages.length > 0) {
            const error = new AppError(
                acceptedFaces === 0
                    ? "No usable face was detected. Use one clear, well-lit live selfie with your face centered."
                    : "Enrollment requires exactly one clear face and an image accepted by the biometric provider.",
                422
            );

            try {
                await exports.deletePerson({ providerUserId: String(result.person.id) });
            } catch {
                error.statusCode = 503;
                error.message = "The enrollment image was rejected and provider cleanup is pending. Refresh enrollment status before retrying.";
                error.cleanupProviderUserId = String(result.person.id);
            }
            throw error;
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
exports.detect = async ({ userId, imageBuffer, mimeType }) => {
    if (!Buffer.isBuffer(imageBuffer)) throw new AppError('Biometric frame is required', 400);
    if (!userId || typeof userId !== 'string') throw new AppError('Authenticated student identity is required for liveness', 400);

    const form = new FormData();
    form.append('image', new Blob([imageBuffer], { type: mimeType || 'image/jpeg' }), 'liveness-frame.jpg');
    form.append('max_faces', '2');
    form.append('collection_id', process.env.BIOMETRIC_COLLECTION_ID || 'students');
    // The provider must check face detection, passive PAD and enrolled identity
    // within this same request/frame, rather than matching only the initial frame.
    form.append('expected_person_id', userId);
    const result = await request({ path: '/v1/detect', method: 'POST', body: form });

    if (!Array.isArray(result?.faces) || result.faces.length !== 1) {
        if (!Array.isArray(result?.faces) || result.faces.length === 0) {
            throw new AppError('No face was detected in this liveness frame. Center your face in the oval, face the light, and keep your eyes and mouth visible.', 401);
        }
        throw new AppError('More than one face was detected. Keep only the enrolled student in the camera frame.', 401);
    }

    const face = result.faces[0];
    const liveness = face?.liveness;
    if (!liveness) throw new AppError('The provider could not evaluate passive liveness for this frame. Improve lighting and retry.', 502);
    if (liveness.status !== 'ok') {
        throw new AppError('Passive liveness could not be evaluated for this frame. Hold still briefly and keep your full face visible.', 401);
    }
    if (liveness.is_live !== true) {
        throw new AppError('The frame did not pass passive liveness. Use the live front camera, not a photograph or screen.', 401);
    }
    const liveScore = Number(liveness.live_score);
    if (!Number.isFinite(liveScore) || liveScore < 0 || liveScore > 1) throw new AppError('Biometric provider returned an invalid liveness score', 502);

    // The current standalone provider returns detection + liveness, but older
    // deployed versions do not return the identity fields in /v1/detect.
    // Fail closed if the provider supplies a partial/malformed identity result.
    // For the legacy contract only, run the existing enrolled-face search on
    // this exact same frame; verify() enforces liveness, top match and threshold.
    const identityFieldsPresent = [
        'identity_verified',
        'matched_person_id',
        'identity_similarity'
    ].some((key) => Object.prototype.hasOwnProperty.call(result, key));

    let identityVerified = result.identity_verified === true;
    let matchedPersonId = String(result.matched_person_id || '');
    let identitySimilarity = Number(result.identity_similarity);
    let identityVerificationId = String(result.identity_request_id || result.request_id || '');

    if (!identityFieldsPresent) {
        const identityResult = await exports.verify({ userId, imageBuffer, mimeType });
        identityVerified = identityResult?.verified === true;
        matchedPersonId = String(identityResult?.providerUserId || '');
        identitySimilarity = Number(identityResult?.similarity);
        identityVerificationId = String(identityResult?.verificationId || identityVerificationId);
    }

    if (identityVerified !== true || matchedPersonId !== userId) {
        throw new AppError('The face did not match the enrolled student in this liveness frame. Keep the same person in view throughout the challenge.', 401);
    }
    if (!Number.isFinite(identitySimilarity) || identitySimilarity < 0 || identitySimilarity > 1) {
        throw new AppError('Biometric provider returned an invalid identity similarity score', 502);
    }

    const ActiveLiveness = require('./ActiveLiveness');
    return {
        livenessPassed: true,
        livenessScore: liveScore,
        identityVerified: true,
        providerUserId: userId,
        identitySimilarity,
        identityVerificationId,
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
