const Course = require("../../models/Course.model");
const ClassSection = require("../../models/ClassSection.model");
const Enrollment = require("../../models/Enrollment.model");
const User = require("../../models/Auth.model");
const AppError = require("../../utils/AppError");

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
        return Enrollment.find({
    sectionId,
    status: "ACTIVE"
})
    .populate({
        path: "studentId",
        select: "Name email RollNumber"
    })
    .sort({
        rollNumber: 1
    })
    .lean();
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

exports.getSectionStudents = async ({
    sectionId
}) => {

    const section = await ClassSection
        .findOne({
            _id: sectionId,
            status: "ACTIVE"
        })
        .lean();

    if (!section) {
        throw new AppError(
            "Section not found",
            404
        );
    }

    return Enrollment.find({
        sectionId,
        status: "ACTIVE"
    })
        .populate({
            path: "studentId",
            select: "name email studentNumber"
        })
        .sort({
            rollNumber: 1
        })
        .lean();
};