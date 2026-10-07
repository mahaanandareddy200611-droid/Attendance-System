const jwt =
    require("jsonwebtoken");

const {
    Server
} = require("socket.io");

const Redis =
    require("ioredis");

const {
    createAdapter
} = require(
    "@socket.io/redis-adapter"
);

const AttendanceSession =
    require("../models/AttendanceSession.model");


let io = null;

let pubClient = null;
let subClient = null;


const sessionRoom =
    (sessionId) =>
        `attendance:session:${sessionId}`;


const getAllowedOrigins = () => {

    return (
        process.env.CORS_ORIGINS ||
        ""
    )
        .split(",")
        .map(
            (value) => value.trim()
        )
        .filter(Boolean);
};


const extractToken = (
    value
) => {

    if (
        typeof value !== "string"
    ) {
        return null;
    }

    if (
        value.startsWith(
            "Bearer "
        )
    ) {
        return value.slice(7).trim();
    }

    return value.trim();
};


const initializeSocket =
    async (httpServer) => {

        if (io) {
            return io;
        }


        if (
            !process.env.REDIS_URL
        ) {

            throw new Error(
                "REDIS_URL is required for Socket.IO"
            );
        }


        pubClient =
            new Redis(
                process.env.REDIS_URL,
                {
                    lazyConnect: true
                }
            );

        subClient =
            pubClient.duplicate();


        await Promise.all([
            pubClient.connect(),
            subClient.connect()
        ]);


        pubClient.on(
            "error",
            (error) => {
                console.error(
                    "Socket Redis publisher error:",
                    error
                );
            }
        );

        subClient.on(
            "error",
            (error) => {
                console.error(
                    "Socket Redis subscriber error:",
                    error
                );
            }
        );


        io =
            new Server(
                httpServer,
                {
                    cors: {
                        origin:
                            getAllowedOrigins(),

                        credentials: true
                    },

                    /*
                     * WebSocket only keeps the
                     * connection on one Node.
                     *
                     * Redis adapter handles
                     * cross-node broadcasts.
                     */
                    transports: [
                        "websocket"
                    ]
                }
            );


        io.adapter(
            createAdapter(
                pubClient,
                subClient
            )
        );


        /*
        --------------------------------------------------
        SOCKET AUTHENTICATION
        --------------------------------------------------
        */

        io.use(
            (socket, next) => {

                try {

                    const rawToken =
                        socket.handshake
                            ?.auth
                            ?.token;

                    const token =
                        extractToken(
                            rawToken
                        );


                    if (!token) {

                        return next(
                            new Error(
                                "Authentication required"
                            )
                        );
                    }


                    const user =
                        jwt.verify(
                            token,
                            process.env.JWT_SECRET
                        );


                    if (
                        user.role !==
                        "Lecturer"
                    ) {

                        return next(
                            new Error(
                                "Lecturer access required"
                            )
                        );
                    }


                    socket.user =
                        user;


                    next();

                } catch (error) {

                    next(
                        new Error(
                            "Invalid or expired token"
                        )
                    );
                }
            }
        );


        /*
        --------------------------------------------------
        CONNECTION
        --------------------------------------------------
        */

        io.on(
            "connection",
            (socket) => {

                console.log(
                    "Socket connected:",
                    socket.id
                );


                /*
                ------------------------------------------
                WATCH SESSION
                ------------------------------------------
                */

                socket.on(
                    "attendance:watch",
                    async (
                        payload,
                        callback
                    ) => {

                        try {

                            const sessionId =
                                payload
                                    ?.sessionId;


                            if (
                                typeof sessionId !==
                                "string" ||
                                !sessionId
                            ) {

                                throw new Error(
                                    "sessionId is required"
                                );
                            }


                            const session =
                                await AttendanceSession
                                    .findOne({
                                        sessionId,

                                        lecturerId:
                                            socket.user.id
                                    })
                                    .lean();


                            if (!session) {

                                throw new Error(
                                    "Attendance session not found"
                                );
                            }


                            if (
                                session.status !==
                                "ACTIVE"
                            ) {

                                throw new Error(
                                    "Attendance session is not active"
                                );
                            }


                            socket.join(
                                sessionRoom(
                                    sessionId
                                )
                            );


                            callback?.({
                                success:
                                    true,

                                sessionId
                            });

                        } catch (error) {

                            callback?.({
                                success:
                                    false,

                                message:
                                    error.message
                            });
                        }
                    }
                );


                /*
                ------------------------------------------
                STOP WATCHING
                ------------------------------------------
                */

                socket.on(
                    "attendance:unwatch",
                    (payload) => {

                        const sessionId =
                            payload
                                ?.sessionId;


                        if (
                            typeof sessionId !==
                            "string"
                        ) {
                            return;
                        }


                        socket.leave(
                            sessionRoom(
                                sessionId
                            )
                        );
                    }
                );


                socket.on(
                    "disconnect",
                    () => {

                        console.log(
                            "Socket disconnected:",
                            socket.id
                        );
                    }
                );
            }
        );


        console.log(
            "Socket.IO initialized ✅"
        );


        return io;
    };


const emitAttendanceMarked =
    ({
        sessionId,
        attendanceId,
        rollNumber,
        markedAt,
        alreadyMarked = false
    }) => {

        if (!io) {
            return;
        }


        io.to(
            sessionRoom(
                sessionId
            )
        ).emit(
            "attendance:marked",
            {
                sessionId,

                attendanceId,

                rollNumber,

                status:
                    "PRESENT",

                markedAt,

                alreadyMarked
            }
        );
    };


const emitSessionEnded =
    ({
        sessionId,
        endedAt
    }) => {

        if (!io) {
            return;
        }


        io.to(
            sessionRoom(
                sessionId
            )
        ).emit(
            "attendance:session-ended",
            {
                sessionId,
                endedAt
            }
        );
    };


module.exports = {
    initializeSocket,
    emitAttendanceMarked,
    emitSessionEnded,
    sessionRoom
};