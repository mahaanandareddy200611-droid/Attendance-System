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
    getSectionStudents,
    listCourses,
    listSections,
    searchUsers,
    updateSectionLocation
} = require("./AcademicController");

const {
    createCourse: createCourseSchema,
    createSection: createSectionSchema,
    enrollStudent: enrollStudentSchema,
    updateSectionLocation: updateSectionLocationSchema
} = require("./AcademicValidator");

const router = express.Router();

router.get("/courses", Auth, authorize("Admin", "Lecturer"), listCourses);
router.get("/sections", Auth, authorize("Admin", "Lecturer", "Student"), listSections);
router.get("/users", Auth, authorize("Admin"), searchUsers);

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

router.patch(
    "/sections/:sectionId/location",
    Auth,
    authorize("Admin"),
    validate(updateSectionLocationSchema),
    updateSectionLocation
);
module.exports = router;
