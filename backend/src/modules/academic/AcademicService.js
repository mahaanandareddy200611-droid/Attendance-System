const mongoose = require("mongoose");
const Course = require("../../models/Course.model");
const ClassSection = require("../../models/ClassSection.model");
const AttendanceSession = require("../../models/AttendanceSession.model");
const Enrollment = require("../../models/Enrollment.model");
const User = require("../../models/Auth.model");
const AppError = require("../../utils/AppError");

const normalizePage = (value, fallback, maximum) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, maximum)
        : fallback;
};

const pagination = (page, limit, total) => ({
    page,
    limit,
    total,
    pages: Math.ceil(total / limit)
});

exports.listCourses = async ({ query = "", page: pageInput, limit: limitInput } = {}) => {
    const page = normalizePage(pageInput, 1, 100000);
    const limit = normalizePage(limitInput, 20, 100);
    const filter = { status: "ACTIVE" };

    if (String(query).trim()) {
        const expression = new RegExp(
            String(query).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i"
        );
        filter.$or = [
            { code: expression },
            { name: expression },
            { department: expression }
        ];
    }

    const [data, total] = await Promise.all([
        Course.find(filter)
            .sort({ code: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        Course.countDocuments(filter)
    ]);

    return { data, pagination: pagination(page, limit, total) };
};

exports.listSections = async ({ userId, role, query = "", page: pageInput, limit: limitInput } = {}) => {
    const page = normalizePage(pageInput, 1, 100000);
    const limit = normalizePage(limitInput, 20, 100);
    const filter = { status: "ACTIVE" };

    if (role === "Lecturer") {
        filter.lecturers = userId;
    } else if (role === "Student") {
        const enrollments = await Enrollment.find({
            studentId: userId,
            status: "ACTIVE"
        }).select("sectionId").lean();
        filter._id = { $in: enrollments.map((item) => item.sectionId) };
    }

    const normalizedQuery = String(query).trim();
    if (normalizedQuery) {
        const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const matchingCourses = await Course.find({
            $or: [
                { code: new RegExp(escaped, "i") },
                { name: new RegExp(escaped, "i") }
            ]
        }).distinct("_id");
        filter.$or = [
            { name: new RegExp(escaped, "i") },
            { academicYear: new RegExp(escaped, "i") },
            { "room.code": new RegExp(escaped, "i") },
            { courseId: { $in: matchingCourses } }
        ];
    }

    const [data, total] = await Promise.all([
        ClassSection.find(filter)
            .populate("courseId", "code name department semester")
            .sort({ academicYear: -1, name: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        ClassSection.countDocuments(filter)
    ]);

    return {
        data,
        pagination: pagination(page, limit, total)
    };
};

exports.searchUsers = async ({ role, query = "", page: pageInput, limit: limitInput } = {}) => {
    if (!["Student", "Lecturer"].includes(role)) {
        throw new AppError("A supported user role is required", 400);
    }

    const page = normalizePage(pageInput, 1, 100000);
    const limit = normalizePage(limitInput, 20, 100);
    const filter = { role, status: "ACTIVE" };
    const normalizedQuery = String(query).trim();

    if (normalizedQuery) {
        const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [
            { Name: new RegExp(escaped, "i") },
            { email: new RegExp(escaped, "i") },
            { RollNumber: new RegExp(escaped, "i") }
        ];
    }

    const [data, total] = await Promise.all([
        User.find(filter)
            .select("Name email RollNumber role")
            .sort({ Name: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        User.countDocuments(filter)
    ]);

    return { data, pagination: pagination(page, limit, total) };
};

exports.createCourse = async ({
    code,
    name,
    department,
    semester
}) => {
    try {
        return await Course.create({
            code,
            name,
            department,
            semester
        });
    } catch (error) {
        if (error.code === 11000) {
            throw new AppError(
                "Course code already exists",
                409
            );
        }

        throw error;
    }
};

exports.createSection = async ({
    courseId,
    name,
    academicYear,
    semester,
    roomCode,
    latitude,
    longitude,
    geofenceRadiusMeters,
    lecturers
}) => {

    const course = await Course.findById(courseId);

    if (!course) {
        throw new AppError(
            "Course not found",
            404
        );
    }

    if (course.status !== "ACTIVE") {
        throw new AppError(
            "Course is not active",
            400
        );
    }

    if (Number(semester) !== Number(course.semester)) {
        throw new AppError(
            "Section semester does not match course semester",
            400
        );
    }

    if (lecturers && lecturers.length > 0) {
        const validLecturers = await User.countDocuments({
            _id: { $in: lecturers },
            role: "Lecturer",
            status: "ACTIVE"
        });

        if (validLecturers !== lecturers.length) {
            throw new AppError(
                "One or more lecturers are invalid",
                400
            );
        }
    }

    try {
        return await ClassSection.create({
            courseId,
            name,
            academicYear,
            semester,
            room: {
                code: roomCode,
                latitude,
                longitude,
                geofenceRadiusMeters
            },
            lecturers: lecturers || []
        });
    } catch (error) {
        if (error.code === 11000) {
            throw new AppError(
                "This class section already exists",
                409
            );
        }

        throw error;
    }
};

exports.enrollStudent = async ({
    studentId,
    sectionId,
    rollNumber
}) => {

    const student = await User.findOne({
        _id: studentId,
        role: "Student",
        status: "ACTIVE"
    });

    if (!student) {
        throw new AppError(
            "Active student not found",
            404
        );
    }

    if (student.RollNumber !== rollNumber) {
        throw new AppError("Roll number does not match the selected student", 400);
    }

    const section = await ClassSection.findOne({
        _id: sectionId,
        status: "ACTIVE"
    });

    if (!section) {
        throw new AppError(
            "Active section not found",
            404
        );
    }

    try {
        return await Enrollment.create({
            studentId,
            sectionId,
            rollNumber
        });
    } catch (error) {
        if (error.code === 11000) {

            const existingStudent =
                await Enrollment.findOne({
                    studentId,
                    sectionId
                });

            if (existingStudent) {
                throw new AppError(
                    "Student is already enrolled in this section",
                    409
                );
            }

            throw new AppError(
                "Roll number is already used in this section",
                409
            );
        }

        throw error;
    }
};

exports.getSectionStudents = async ({ sectionId, userId, role, query = "", page: pageInput, limit: limitInput }) => {
    const page = normalizePage(pageInput, 1, 100000);
    const limit = normalizePage(limitInput, 50, 100);
    const sectionFilter = { _id: sectionId, status: "ACTIVE" };
    if (role === "Lecturer") sectionFilter.lecturers = userId;

    const section = await ClassSection
        .findOne(sectionFilter)
        .lean();

    if (!section) {
        throw new AppError(
            "Section not found",
            404
        );
    }

    const filter = {
        sectionId,
        status: "ACTIVE"
    };
    const normalizedQuery = String(query).trim();
    if (normalizedQuery) {
        const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const matchingStudents = await User.find({
            role: "Student",
            $or: [
                { Name: new RegExp(escaped, "i") },
                { email: new RegExp(escaped, "i") },
                { RollNumber: new RegExp(escaped, "i") }
            ]
        }).distinct("_id");
        filter.$or = [
            { studentId: { $in: matchingStudents } },
            { rollNumber: new RegExp(escaped, "i") }
        ];
    }

    const [data, total] = await Promise.all([
        Enrollment.find(filter)
        .populate({
            path: "studentId",
            select: "Name email RollNumber"
        })
        .sort({
            rollNumber: 1
        })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
        Enrollment.countDocuments(filter)
    ]);

    return { data, pagination: pagination(page, limit, total) };
};

exports.updateSectionLocation = async ({ sectionId, latitude, longitude } = {}) => {
    const id = String(sectionId || "");
    if (!/^[a-f\d]{24}$/i.test(id)) {
        throw new AppError("A valid section ID is required", 400);
    }

    const lat = Number(latitude);
    const lon = Number(longitude);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new AppError("Latitude must be between -90 and 90", 400);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
        throw new AppError("Longitude must be between -180 and 180", 400);
    }

    const dbSession = await mongoose.startSession();
    let updatedSection;

    try {
        await dbSession.withTransaction(async () => {
            // This write intentionally conflicts with createSession's write to
            // the same ClassSection document. Snapshot update and session
            // creation therefore serialize instead of racing on stale room data.
            const section = await ClassSection.findOneAndUpdate(
                { _id: id, status: "ACTIVE" },
                {
                    $set: {
                        "room.latitude": lat,
                        "room.longitude": lon
                    },
                    $inc: { locationVersion: 1 }
                },
                {
                    new: true,
                    runValidators: true,
                    session: dbSession
                }
            ).select("_id name room");

            if (!section) {
                throw new AppError("Active class section not found", 404);
            }

            const activeSession = await AttendanceSession.findOne({
                sectionId: id,
                status: "ACTIVE",
                expiresAt: { $gt: new Date() }
            })
                .select("sessionId expiresAt")
                .session(dbSession)
                .lean();

            if (activeSession) {
                throw new AppError(
                    "End the active attendance session before changing this room location",
                    409
                );
            }

            updatedSection = section.toObject();
        });

        return updatedSection;
    } finally {
        await dbSession.endSession();
    }
};