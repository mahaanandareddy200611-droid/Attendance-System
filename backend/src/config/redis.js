const {
    createClient
} = require("redis");

if (!process.env.REDIS_URL) {
    throw new Error(
        "REDIS_URL is not configured"
    );
}

const redisClient =
    createClient({
        url: process.env.REDIS_URL
    });

redisClient.on(
    "error",
    (error) => {
        console.error(
            "Redis Client Error ❌",
            error
        );
    }
);

const connectRedis = async () => {

    if (redisClient.isOpen) {
        return;
    }

    await redisClient.connect();

    console.log(
        "Redis Connected ✅"
    );
};

module.exports = {
    redisClient,
    connectRedis
};