const AttendanceRecord = require("../../models/AttendanceRecord.model");
const AttendanceSession = require("../../models/AttendanceSession.model");
const AttendanceSessionStudent = require("../../models/AttendanceSessionStudent.model");
const User = require("../../models/Auth.model");
const Enrollment = require("../../models/Enrollment.model");
const AppError = require("../../utils/AppError");

function getPageOptions(query) {
  const requestedPage = Number.parseInt(query.page, 10);
  const requestedLimit = Number.parseInt(query.limit, 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 25;
  return { page, limit, skip: (page - 1) * limit };
}

function makeDateFilter(query) {
  const filter = {};
  if (query.from || query.to) {
    const from = query.from ? new Date(query.from) : new Date(0);
    const to = query.to ? new Date(query.to) : new Date();
    if (query.to) to.setUTCDate(to.getUTCDate() + 1);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new AppError("Valid from/to dates are required", 400);
    }
    filter.markedAt = { $gte: from, $lt: to };
  }
  if (query.courseCode) filter.courseCode = String(query.courseCode).trim().toUpperCase();
  if (query.section) filter.section = String(query.section).trim().toUpperCase();
  return filter;
}

function pagination(page, limit, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

exports.listSessions = async ({ userId, role, query = {} }) => {
  const { page, limit, skip } = getPageOptions(query);
  const filter = {};
  if (role === "Lecturer") filter.lecturerId = userId;
  if (query.status) filter.status = query.status;
  if (query.status === "ACTIVE") filter.expiresAt = { $gt: new Date() };

  const [data, total] = await Promise.all([
    AttendanceSession.find(filter)
      .populate("sectionId", "name academicYear room.code")
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AttendanceSession.countDocuments(filter),
  ]);
  return { data, pagination: pagination(page, limit, total) };
};

exports.listAvailableStudentSessions = async ({ studentId }) => {
  const enrolledSections = await Enrollment.find({
    studentId,
    status: "ACTIVE",
  }).distinct("sectionId");
  const data = await AttendanceSession.find({
    sectionId: { $in: enrolledSections },
    status: "ACTIVE",
    expiresAt: { $gt: new Date() },
  })
    .populate("sectionId", "name academicYear room.code")
    .sort({ startedAt: -1 })
    .select("sessionId sectionId courseCode section status startedAt expiresAt")
    .lean();
  return { data };
};

exports.listSessionRecords = async ({ sessionId, userId, role, query = {} }) => {
  const sessionFilter = { sessionId };
  if (role === "Lecturer") sessionFilter.lecturerId = userId;
  const session = await AttendanceSession.findOne(sessionFilter).lean();
  if (!session) throw new AppError("Attendance session not found", 404);

  const { page, limit, skip } = getPageOptions(query);
  const filter = { sessionId: session._id };
  const normalizedQuery = String(query.q || "").trim();
  if (normalizedQuery) {
    const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchingStudents = await User.find({
      role: "Student",
      $or: [
        { Name: new RegExp(escaped, "i") },
        { email: new RegExp(escaped, "i") },
        { RollNumber: new RegExp(escaped, "i") },
      ],
    }).distinct("_id");
    filter.$or = [
      { studentId: { $in: matchingStudents } },
      { rollNumber: new RegExp(escaped, "i") },
    ];
  }
  const [roster, total] = await Promise.all([
    AttendanceSessionStudent.find(filter)
      .populate("studentId", "Name email RollNumber")
      .sort({ rollNumber: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AttendanceSessionStudent.countDocuments(filter),
  ]);
  const attendance = await AttendanceRecord.find({
    sessionId: session._id,
    studentId: { $in: roster.map((item) => item.studentId?._id).filter(Boolean) },
  }).lean();
  const attendanceByStudent = new Map(attendance.map((record) => [String(record.studentId), record]));
  const data = roster.map((entry) => ({
    ...entry,
    attendance: attendanceByStudent.get(String(entry.studentId?._id)) || null,
  }));
  return { session, data, pagination: pagination(page, limit, total) };
};

exports.listStudentRecords = async ({ studentId, query = {} }) => {
  const { page, limit, skip } = getPageOptions(query);
  const filter = { studentId, ...makeDateFilter(query) };
  const [data, total] = await Promise.all([
    AttendanceRecord.find(filter)
      .populate("sessionId", "sessionId status startedAt endedAt courseCode section")
      .sort({ markedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AttendanceRecord.countDocuments(filter),
  ]);
  return { data, pagination: pagination(page, limit, total) };
};

exports.listAdminRecords = async ({ userId, role, query = {} }) => {
  const { page, limit, skip } = getPageOptions(query);
  const filter = makeDateFilter(query);
  if (role === "Lecturer") {
    const ownedSessions = await AttendanceSession.find({ lecturerId: userId }).distinct("_id");
    filter.sessionId = { $in: ownedSessions };
  }
  const normalizedQuery = String(query.q || "").trim();
  if (normalizedQuery) {
    const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchingStudents = await User.find({
      role: "Student",
      $or: [
        { Name: new RegExp(escaped, "i") },
        { email: new RegExp(escaped, "i") },
        { RollNumber: new RegExp(escaped, "i") },
      ],
    }).distinct("_id");
    filter.studentId = { $in: matchingStudents };
  }
  const [data, total] = await Promise.all([
    AttendanceRecord.find(filter)
      .populate("studentId", "Name email RollNumber")
      .populate("sessionId", "sessionId status startedAt endedAt lecturerId")
      .sort({ markedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AttendanceRecord.countDocuments(filter),
  ]);
  return { data, pagination: pagination(page, limit, total) };
};
