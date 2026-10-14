const COURSE_ID = "64b000000000000000000001";
const SECTION_ID = "64b000000000000000000002";
const STUDENT_ID = "64b000000000000000000003";
const LECTURER_ID = "64b000000000000000000004";
const SESSION_ID = "preview-attendance-session";

const COURSE = {
  _id: COURSE_ID,
  code: "CS101",
  name: "Introduction to Computing",
  department: "CSE",
  semester: 1,
  status: "ACTIVE",
};

const SECTION = {
  _id: SECTION_ID,
  courseId: COURSE,
  name: "A",
  academicYear: "2026-2027",
  semester: 1,
  room: {
    code: "B-204",
    latitude: 17.385,
    longitude: 78.4867,
    geofenceRadiusMeters: 100,
  },
  lecturers: [LECTURER_ID],
  status: "ACTIVE",
};

const STUDENT = {
  _id: STUDENT_ID,
  Name: "Aarav Kumar",
  email: "aarav@example.edu",
  RollNumber: "24BCS101",
  role: "Student",
};

const LECTURER = {
  _id: LECTURER_ID,
  Name: "Dr. Meera Rao",
  email: "meera@example.edu",
  role: "Lecturer",
};

const SESSION = {
  sessionId: SESSION_ID,
  sectionId: SECTION_ID,
  courseCode: COURSE.code,
  section: SECTION.name,
  status: "ACTIVE",
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
  eligibleStudentCount: 32,
};

const ROSTER = [
  {
    _id: "64b000000000000000000010",
    studentId: STUDENT,
    rollNumber: STUDENT.RollNumber,
    status: "PRESENT",
    attendance: {
      markedAt: new Date().toISOString(),
      verification: {
        qr: true,
        device: true,
        proximity: true,
        biometric: true,
      },
    },
  },
  {
    _id: "64b000000000000000000011",
    studentId: {
      ...STUDENT,
      _id: "64b000000000000000000005",
      Name: "Ananya Shah",
      RollNumber: "24BCS102",
      email: "ananya@example.edu",
    },
    rollNumber: "24BCS102",
    status: "ELIGIBLE",
    attendance: null,
  },
];

let deviceRegistered = false;
let biometricEnrolled = false;
let sessionActive = true;

const response = (config, data, status = 200) => ({
  config,
  data,
  status,
  statusText: status === 201 ? "Created" : "OK",
  headers: {},
  request: {},
});

const paginated = (data, config) => ({
  success: true,
  data,
  pagination: {
    page: Number(config.params?.page) || 1,
    limit: Number(config.params?.limit) || 20,
    total: data.length,
    pages: data.length ? 1 : 0,
  },
});

const parseBody = (config) => {
  if (!config.data || typeof config.data !== "string") return config.data || {};
  try {
    return JSON.parse(config.data);
  } catch {
    return {};
  }
};

export async function previewAdapter(config) {
  const method = (config.method || "get").toLowerCase();
  const path = String(config.url || "")
    .replace(/^\//, "")
    .split("?")[0];
  const body = parseBody(config);
  let data = { success: true, data: null };
  let status = 200;

  if (path === "auth/me") {
    data = {
      success: true,
      data: {
        id: LECTURER_ID,
        name: "Meera Rao",
        email: "meera@example.edu",
        role: "Lecturer",
      },
    };
  } else if (path === "academic/courses" && method === "get") {
    data = paginated([COURSE], config);
  } else if (path === "academic/sections" && method === "get") {
    data = paginated([SECTION], config);
  } else if (path === "academic/users" && method === "get") {
    data = paginated(
      config.params?.role === "Student" ? [STUDENT] : [LECTURER],
      config,
    );
  } else if (
    /^academic\/sections\/[^/]+\/students$/.test(path) &&
    method === "get"
  ) {
    data = { ...paginated(ROSTER, config), count: ROSTER.length };
  } else if (
    path === "academic/courses" ||
    path === "academic/sections" ||
    path === "academic/enrollments" ||
    path === "auth/lecturers"
  ) {
    data = {
      success: true,
      message: "Preview action completed.",
      data: { _id: COURSE_ID, ...body },
    };
    status = 201;
  } else if (path === "attendance/sessions/available") {
    data = { success: true, data: sessionActive ? [SESSION] : [] };
  } else if (path === "attendance/sessions" && method === "get") {
    data = paginated(sessionActive ? [SESSION] : [], config);
  } else if (path === "attendance/sessions" && method === "post") {
    sessionActive = true;
    data = {
      success: true,
      message: "Attendance session created",
      data: SESSION,
    };
    status = 201;
  } else if (
    path === "attendance/records/me" ||
    path === "attendance/records"
  ) {
    const record = {
      _id: "64b000000000000000000020",
      courseCode: COURSE.code,
      section: SECTION.name,
      studentId: STUDENT,
      sessionId: SESSION,
      markedAt: new Date().toISOString(),
      verification: {
        qr: true,
        device: true,
        proximity: true,
        biometric: true,
      },
    };
    data = paginated([record], config);
  } else if (path === `attendance/sessions/${SESSION_ID}/qr`) {
    const payload = btoa(
      JSON.stringify({ sid: SESSION_ID, slot: 1, nonce: "preview" }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    data = {
      success: true,
      data: { token: `${payload}.preview-signature`, refreshMs: 3000 },
    };
  } else if (path === `attendance/sessions/${SESSION_ID}/records`) {
    data = { success: true, session: SESSION, ...paginated(ROSTER, config) };
  } else if (/^attendance\/sessions\/[^/]+\/end$/.test(path)) {
    sessionActive = false;
    data = {
      success: true,
      message: "Attendance session ended",
      data: { sessionId: SESSION_ID, status: "ENDED" },
    };
  } else if (path === "attendance/verify") {
    data = {
      success: true,
      message: "Preview attendance marked successfully.",
    };
    status = 201;
  } else if (path === "devices/me" && method === "get") {
    data = {
      success: true,
      data: deviceRegistered
        ? { deviceId: "preview-browser-device", status: "ACTIVE" }
        : null,
    };
  } else if (path === "devices/me" && method === "delete") {
    deviceRegistered = false;
    data = {
      success: true,
      data: null,
      message: "Preview browser unregistered.",
    };
  } else if (path === "devices/registration-challenge") {
    data = {
      success: true,
      data: {
        challengeId: "preview-challenge",
        challenge: "preview-device-challenge",
      },
    };
  } else if (path === "devices/register") {
    deviceRegistered = true;
    data = {
      success: true,
      message: "Preview browser registered.",
      data: { deviceId: body.deviceId, status: "ACTIVE" },
    };
    status = 201;
  } else if (path === "biometric/me") {
    data = {
      success: true,
      data: biometricEnrolled
        ? { status: "ACTIVE", enrolledAt: new Date().toISOString() }
        : null,
    };
  } else if (path === "biometric/enroll") {
    biometricEnrolled = true;
    data = {
      success: true,
      message: "Preview face enrollment completed.",
      data: { status: "ACTIVE" },
    };
    status = 201;
  } else if (path === "biometric/challenge") {
    data = {
      success: true,
      data: { challengeId: "preview-biometric-challenge" },
    };
  } else if (path === "biometric/verify") {
    data = {
      success: true,
      data: { verified: true, assertionId: "preview-biometric-assertion" },
    };
  }

  return response(config, data, status);
}

export function previewUser(role) {
  if (!import.meta.env.DEV || !["Admin", "Lecturer", "Student"].includes(role))
    return null;
  return {
    id:
      role === "Student"
        ? STUDENT_ID
        : role === "Lecturer"
          ? LECTURER_ID
          : "64b000000000000000000006",
    name:
      role === "Student"
        ? STUDENT.Name
        : role === "Lecturer"
          ? LECTURER.Name
          : "System Admin",
    email:
      role === "Student"
        ? STUDENT.email
        : role === "Lecturer"
          ? LECTURER.email
          : "admin@example.edu",
    role,
  };
}
