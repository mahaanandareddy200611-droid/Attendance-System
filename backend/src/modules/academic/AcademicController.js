const asyncHandler =
    require("../../middlewares/asyncHandler");

const academicService =
    require("./AcademicService");

exports.createCourse = asyncHandler(
    async (req, res) => {

        const course =
            await academicService.createCourse(
                req.body
            );

        return res.status(201).json({
            success: true,
            data: course
        });
    }
);

exports.createSection = asyncHandler(
    async (req, res) => {

        const section =
            await academicService.createSection(
                req.body
            );

        return res.status(201).json({
            success: true,
            data: section
        });
    }
);

exports.enrollStudent = asyncHandler(
    async (req, res) => {

        const enrollment =
            await academicService.enrollStudent(
                req.body
            );

        return res.status(201).json({
            success: true,
            data: enrollment
        });
    }
);

exports.getSectionStudents =
    asyncHandler(
        async (req, res) => {

            const students =
                await academicService
                    .getSectionStudents({
                        sectionId:
                            req.params.sectionId
                    });

            return res.status(200).json({
                success: true,
                count: students.length,
                data: students
            });
        }
    );