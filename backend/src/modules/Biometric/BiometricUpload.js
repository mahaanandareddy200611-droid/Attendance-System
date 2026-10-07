const multer =
    require("multer");


const upload =
    multer({
        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                1024 * 1024,

            files: 1
        },

        fileFilter:
            (
                req,
                file,
                callback
            ) => {

                const allowed =
                    [
                        "image/jpeg",
                        "image/png",
                        "image/webp"
                    ];

                if (
                    !allowed.includes(
                        file.mimetype
                    )
                ) {

                    return callback(
                        new Error(
                            "Only JPEG, PNG and WebP images are allowed"
                        )
                    );
                }

                callback(
                    null,
                    true
                );
            }
    });


module.exports =
    upload;