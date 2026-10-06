const express = require("express");

const validate =
    require("../../utils/validate");

const Auth =
    require("../../middlewares/Auth");

const authorize =
    require("../../middlewares/authorize");

const {
    createCourse,
    createSection,
    enrollStudent,
    getSectionStudents
} = require("./AcademicController");

const {
    createCourse: createCourseSchema,
    createSection: createSectionSchema,
    enrollStudent: enrollStudentSchema
} = require("./AcademicValidator");

const router = express.Router();

/*
|--------------------------------------------------------------------------
| COURSE
|--------------------------------------------------------------------------
*/

router.post(
    "/courses",
    Auth,
    authorize("Admin"),
    validate(createCourseSchema),
    createCourse
);

/*
|--------------------------------------------------------------------------
| SECTION
|--------------------------------------------------------------------------
*/

router.post(
    "/sections",
    Auth,
    authorize("Admin"),
    validate(createSectionSchema),
    createSection
);

/*
|--------------------------------------------------------------------------
| ENROLLMENT
|--------------------------------------------------------------------------
*/

router.post(
    "/enrollments",
    Auth,
    authorize("Admin"),
    validate(enrollStudentSchema),
    enrollStudent
);

/*
|--------------------------------------------------------------------------
| SECTION STUDENTS
|--------------------------------------------------------------------------
*/

router.get(
    "/sections/:sectionId/students",
    Auth,
    authorize("Admin", "Lecturer"),
    getSectionStudents
);

module.exports = router;