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
                        sectionId: req.params.sectionId,
                        userId: req.user.id,
                        role: req.user.role,
                        query: req.query.q,
                        page: req.query.page,
                        limit: req.query.limit
                    });

            return res.status(200).json({
                success: true,
                count: students.data.length,
                data: students.data,
                pagination: students.pagination
            });
        }
    );

exports.listCourses = asyncHandler(async (req, res) => {
    const result = await academicService.listCourses({
        query: req.query.q,
        page: req.query.page,
        limit: req.query.limit
    });
    return res.status(200).json({ success: true, ...result });
});

exports.listSections = asyncHandler(async (req, res) => {
    const result = await academicService.listSections({
        userId: req.user.id,
        role: req.user.role,
        query: req.query.q,
        page: req.query.page,
        limit: req.query.limit
    });
    return res.status(200).json({ success: true, ...result });
});

exports.searchUsers = asyncHandler(async (req, res) => {
    const result = await academicService.searchUsers({
        role: req.query.role,
        query: req.query.q,
        page: req.query.page,
        limit: req.query.limit
    });
    return res.status(200).json({ success: true, ...result });
});
