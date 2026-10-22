import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  createCourse,
  createSection,
  enrollStudent,
  getCourses,
  getSections,
  searchAcademicUsers,
} from "../services/academic.service";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

const initialCourse = { code: "", name: "", department: "", semester: "" };
const initialSection = {
  courseId: "",
  name: "",
  academicYear: "",
  semester: "",
  roomCode: "",
  latitude: "",
  longitude: "",
  geofenceRadiusMeters: "100",
  lecturers: "",
};
const initialEnrollment = { studentId: "", sectionId: "", rollNumber: "" };

function AdminAcademic() {
  const { pathname } = useLocation();
  const view =
    pathname === "/admin/dashboard"
      ? "dashboard"
      : pathname.endsWith("/courses")
        ? "courses"
        : pathname.endsWith("/sections")
          ? "sections"
          : pathname.endsWith("/enrollments")
            ? "enrollments"
            : "overview";
  const [course, setCourse] = useState(initialCourse);
  const [section, setSection] = useState(initialSection);
  const [enrollment, setEnrollment] = useState(initialEnrollment);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const [courses, setCourses] = useState([]);
  const [sections, setSections] = useState([]);
  const [students, setStudents] = useState([]);
  const [lecturers, setLecturers] = useState([]);

  const loadAcademicOptions = async () => {
    const results = await Promise.allSettled([
      getCourses({ limit: 100 }),
      getSections({ limit: 100 }),
      searchAcademicUsers({ role: "Student", limit: 100 }),
      searchAcademicUsers({ role: "Lecturer", limit: 100 }),
    ]);
    const failures = [];
    const apply = (index, label, setter) => {
      const result = results[index];
      if (result.status === "fulfilled") {
        setter(result.value.data?.data || []);
      } else {
        failures.push(label);
      }
    };
    apply(0, "courses", setCourses);
    apply(1, "sections", setSections);
    apply(2, "students", setStudents);
    apply(3, "lecturers", setLecturers);
    if (failures.length) {
      setNotice({
        type: "error",
        text: `Some Admin data could not load: ${failures.join(", ")}. Other lists are still available; retry the failed action.`,
      });
    }
  };

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      getCourses({ limit: 100 }),
      getSections({ limit: 100 }),
      searchAcademicUsers({ role: "Student", limit: 100 }),
      searchAcademicUsers({ role: "Lecturer", limit: 100 }),
    ]).then((results) => {
      if (!active) return;
      const failures = [];
      const apply = (index, label, setter) => {
        const result = results[index];
        if (result.status === "fulfilled") {
          setter(result.value.data?.data || []);
        } else {
          failures.push(label);
        }
      };
      apply(0, "courses", setCourses);
      apply(1, "sections", setSections);
      apply(2, "students", setStudents);
      apply(3, "lecturers", setLecturers);
      if (failures.length) {
        setNotice({
          type: "error",
          text: `Some Admin data could not load: ${failures.join(", ")}. Retry after checking the connection; other loaded data remains available.`,
        });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event, kind, request, reset) => {
    event.preventDefault();
    setNotice(null);
    setBusy(kind);
    try {
      const response = await request();
      const created = response.data?.data;
      const id = created?._id || created?.id;
      setNotice({
        type: "success",
        text: `${kind} completed.${id ? ` ID: ${id}` : ""}`,
      });
      reset();
      await loadAcademicOptions();
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error.response?.data?.error?.message ||
          error.response?.data?.message ||
          `${kind} failed. Check the entered IDs and your Admin access.`,
      });
    } finally {
      setBusy("");
    }
  };

  const field = (label, value, onChange, options = {}) => (
    <label className="academic-field" key={options.name || label}>
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={!options.optional}
        type={options.type || "text"}
        min={options.min}
        max={options.max}
        step={options.step}
        placeholder={options.placeholder || ""}
      />
      {options.help && <small>{options.help}</small>}
    </label>
  );

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">ACADEMIC SETUP</p>
            <h1>
              {view === "dashboard"
                ? "Academic overview"
                : view === "courses"
                  ? "Course catalog"
                  : view === "sections"
                    ? "Class sections"
                    : view === "enrollments"
                      ? "Student enrollment"
                      : "Academic setup"}
            </h1>
            <p>
              {view === "dashboard"
                ? "A quick view of the academic records configured for your institution."
                : "Set up courses, teaching sections, and student enrollments."}
            </p>
          </div>
          <span className="academic-role">Admin</span>
        </div>

        {notice && (
          <div className={`academic-notice ${notice.type}`} role="status">
            {notice.text}
          </div>
        )}

        {view === "dashboard" && (
          <>
            <div className="admin-summary-grid">
              <article className="admin-summary-card">
                <span>Active courses</span>
                <strong>{courses.length}</strong>
                <small>In the course catalog</small>
              </article>
              <article className="admin-summary-card">
                <span>Class sections</span>
                <strong>{sections.length}</strong>
                <small>Across academic years</small>
              </article>
              <article className="admin-summary-card">
                <span>Lecturers</span>
                <strong>{lecturers.length}</strong>
                <small>Available for assignment</small>
              </article>
              <article className="admin-summary-card">
                <span>Students</span>
                <strong>{students.length}</strong>
                <small>Available for enrollment</small>
              </article>
            </div>
            <section className="academic-card admin-quick-actions">
              <div>
                <p className="academic-eyebrow">QUICK ACTIONS</p>
                <h2>Continue setting up academics</h2>
                <p>
                  Follow the sequence so lecturers have an assigned class and
                  students can appear in its roster.
                </p>
              </div>
              <div className="admin-action-links">
                <Link className="academic-button" to="/admin/courses">
                  Add a course
                </Link>
                <Link
                  className="academic-button secondary"
                  to="/admin/sections"
                >
                  Create a section
                </Link>
                <Link
                  className="academic-button secondary"
                  to="/admin/enrollments"
                >
                  Enroll students
                </Link>
              </div>
            </section>
          </>
        )}

        <div className="academic-grid">
          {(view === "overview" || view === "courses") && (
            <form
              className="academic-card"
              onSubmit={(event) =>
                submit(
                  event,
                  "Course creation",
                  () =>
                    createCourse({
                      ...course,
                      semester: Number(course.semester),
                    }),
                  () => setCourse(initialCourse),
                )
              }
            >
              <div className="academic-card-title">
                <span className="academic-step">01</span>
                <div>
                  <h2>Create course</h2>
                  <p>Register a course in the catalog.</p>
                </div>
              </div>
              {field(
                "Course code",
                course.code,
                (v) => setCourse({ ...course, code: v }),
                { placeholder: "CS101" },
              )}
              {field(
                "Course name",
                course.name,
                (v) => setCourse({ ...course, name: v }),
                { placeholder: "Introduction to Computing" },
              )}
              {field(
                "Department",
                course.department,
                (v) => setCourse({ ...course, department: v }),
                { placeholder: "CSE" },
              )}
              {field(
                "Semester",
                course.semester,
                (v) => setCourse({ ...course, semester: v }),
                { type: "number", min: 1, max: 12 },
              )}
              <button
                className="academic-button"
                disabled={busy === "Course creation"}
              >
                {busy === "Course creation" ? "Creating…" : "Create course"}
              </button>
            </form>
          )}

          {(view === "overview" || view === "sections") && (
            <form
              className="academic-card"
              onSubmit={(event) =>
                submit(
                  event,
                  "Section creation",
                  () =>
                    createSection({
                      ...section,
                      semester: Number(section.semester),
                      latitude: Number(section.latitude),
                      longitude: Number(section.longitude),
                      geofenceRadiusMeters: Number(
                        section.geofenceRadiusMeters,
                      ),
                      lecturers: section.lecturers
                        .split(",")
                        .map((id) => id.trim())
                        .filter(Boolean),
                    }),
                  () => setSection(initialSection),
                )
              }
            >
              <div className="academic-card-title">
                <span className="academic-step">02</span>
                <div>
                  <h2>Create section</h2>
                  <p>Set the class location and lecturer.</p>
                </div>
              </div>
              <label className="academic-field">
                <span>Course</span>
                <select
                  value={section.courseId}
                  onChange={(event) => {
                    const selected = courses.find(
                      (item) => item._id === event.target.value,
                    );
                    setSection({
                      ...section,
                      courseId: event.target.value,
                      semester: selected ? String(selected.semester) : "",
                    });
                  }}
                  required
                >
                  <option value="">Choose a course</option>
                  {courses.map((item) => (
                    <option key={item._id} value={item._id}>
                      {item.code} — {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="academic-form-row">
                {field(
                  "Section name",
                  section.name,
                  (v) => setSection({ ...section, name: v }),
                  { placeholder: "A" },
                )}
                {field(
                  "Semester",
                  section.semester,
                  (v) => setSection({ ...section, semester: v }),
                  {
                    type: "number",
                    min: 1,
                    max: 12,
                    help: "Uses the selected course semester.",
                  },
                )}
              </div>
              <div className="academic-form-row">
                {field(
                  "Academic year",
                  section.academicYear,
                  (v) => setSection({ ...section, academicYear: v }),
                  { placeholder: "2026-2027" },
                )}
                {field(
                  "Room code",
                  section.roomCode,
                  (v) => setSection({ ...section, roomCode: v }),
                  { placeholder: "B-204" },
                )}
              </div>
              <div className="academic-form-row">
                {field(
                  "Latitude",
                  section.latitude,
                  (v) => setSection({ ...section, latitude: v }),
                  { type: "number", min: -90, max: 90, step: "any" },
                )}
                {field(
                  "Longitude",
                  section.longitude,
                  (v) => setSection({ ...section, longitude: v }),
                  { type: "number", min: -180, max: 180, step: "any" },
                )}
              </div>
              {field(
                "Geofence radius (meters)",
                section.geofenceRadiusMeters,
                (v) => setSection({ ...section, geofenceRadiusMeters: v }),
                {
                  type: "number",
                  min: 5,
                  max: 1000,
                  help: "The attendance location check uses this classroom radius.",
                },
              )}
              <label className="academic-field">
                <span>Assigned lecturer</span>
                <select
                  value={section.lecturers}
                  onChange={(event) =>
                    setSection({ ...section, lecturers: event.target.value })
                  }
                  required
                >
                  <option value="">Choose a lecturer</option>
                  {lecturers.map((item) => (
                    <option key={item._id} value={item._id}>
                      {item.Name} — {item.email}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="academic-button"
                disabled={busy === "Section creation"}
              >
                {busy === "Section creation" ? "Creating…" : "Create section"}
              </button>
            </form>
          )}

          {(view === "overview" || view === "enrollments") && (
            <form
              className="academic-card academic-card-wide"
              onSubmit={(event) =>
                submit(
                  event,
                  "Student enrollment",
                  () => enrollStudent(enrollment),
                  () => setEnrollment(initialEnrollment),
                )
              }
            >
              <div className="academic-card-title">
                <span className="academic-step">03</span>
                <div>
                  <h2>Enroll student</h2>
                  <p>Add an active student account to a section.</p>
                </div>
              </div>
              <div className="academic-form-row academic-enrollment-row">
                <label className="academic-field">
                  <span>Student</span>
                  <select
                    value={enrollment.studentId}
                    onChange={(event) => {
                      const selected = students.find(
                        (item) => item._id === event.target.value,
                      );
                      setEnrollment({
                        ...enrollment,
                        studentId: event.target.value,
                        rollNumber: selected?.RollNumber || "",
                      });
                    }}
                    required
                  >
                    <option value="">Choose a student</option>
                    {students.map((item) => (
                      <option key={item._id} value={item._id}>
                        {item.RollNumber} — {item.Name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="academic-field">
                  <span>Section</span>
                  <select
                    value={enrollment.sectionId}
                    onChange={(event) =>
                      setEnrollment({
                        ...enrollment,
                        sectionId: event.target.value,
                      })
                    }
                    required
                  >
                    <option value="">Choose a section</option>
                    {sections.map((item) => (
                      <option key={item._id} value={item._id}>
                        {item.courseId?.code} — {item.name} ({item.academicYear}
                        )
                      </option>
                    ))}
                  </select>
                </label>
                <label className="academic-field">
                  <span>Roll number</span>
                  <input value={enrollment.rollNumber} readOnly required />
                </label>
              </div>
              <button
                className="academic-button"
                disabled={busy === "Student enrollment"}
              >
                {busy === "Student enrollment"
                  ? "Enrolling…"
                  : "Enroll student"}
              </button>
            </form>
          )}
        </div>
        {(view === "overview" || view === "courses") && (
          <section className="academic-card academic-card-wide">
            <div className="academic-card-title">
              <span className="academic-step">CAT</span>
              <div>
                <h2>Active course catalog</h2>
                <p>{courses.length} courses available for section setup</p>
              </div>
            </div>
            {courses.length ? (
              <div className="academic-table-wrap">
                <table className="academic-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Course</th>
                      <th>Department</th>
                      <th>Semester</th>
                    </tr>
                  </thead>
                  <tbody>
                    {courses.map((item) => (
                      <tr key={item._id}>
                        <td>
                          <strong>{item.code}</strong>
                        </td>
                        <td>{item.name}</td>
                        <td>{item.department}</td>
                        <td>{item.semester}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="academic-empty">
                No active courses have been created.
              </p>
            )}
          </section>
        )}
        {(view === "overview" || view === "sections") && (
          <section className="academic-card academic-card-wide">
            <div className="academic-card-title">
              <span className="academic-step">SEC</span>
              <div>
                <h2>Active class sections</h2>
                <p>{sections.length} sections available for enrollment</p>
              </div>
            </div>
            {sections.length ? (
              <div className="academic-table-wrap">
                <table className="academic-table">
                  <thead>
                    <tr>
                      <th>Course</th>
                      <th>Section</th>
                      <th>Academic year</th>
                      <th>Room</th>
                      <th>Assigned lecturer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sections.map((item) => {
                      const assignedNames = (item.lecturers || [])
                        .map(
                          (id) =>
                            lecturers.find(
                              (lecturer) => String(lecturer._id) === String(id),
                            )?.Name,
                        )
                        .filter(Boolean);
                      return (
                        <tr key={item._id}>
                          <td>
                            <strong>{item.courseId?.code}</strong>
                          </td>
                          <td>{item.name}</td>
                          <td>{item.academicYear}</td>
                          <td>{item.room?.code}</td>
                          <td>
                            {assignedNames.length
                              ? assignedNames.join(", ")
                              : "Unassigned"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="academic-empty">
                No active sections have been created.
              </p>
            )}
          </section>
        )}
        {view !== "dashboard" && (
          <p className="academic-footnote">
            Lists are loaded from the authenticated Admin APIs. Student and
            Lecturer roles are assigned by an authorized account workflow.
          </p>
        )}
      </section>
    </main>
  );
}

export default AdminAcademic;
