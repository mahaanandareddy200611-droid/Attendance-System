import { useState } from "react";
import { Link } from "react-router-dom";
import { createCourse, createSection, enrollStudent } from "../services/academic.service";
import "../Styles/Academic.css";

const initialCourse = { code: "", name: "", department: "", semester: "" };
const initialSection = {
  courseId: "", name: "", academicYear: "", semester: "", roomCode: "",
  latitude: "", longitude: "", geofenceRadiusMeters: "100", lecturers: "",
};
const initialEnrollment = { studentId: "", sectionId: "", rollNumber: "" };

function AdminAcademic() {
  const [course, setCourse] = useState(initialCourse);
  const [section, setSection] = useState(initialSection);
  const [enrollment, setEnrollment] = useState(initialEnrollment);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");

  const submit = async (event, kind, request, reset) => {
    event.preventDefault();
    setNotice(null);
    setBusy(kind);
    try {
      const response = await request();
      const created = response.data?.data;
      const id = created?._id || created?.id;
      setNotice({ type: "success", text: `${kind} completed.${id ? ` ID: ${id}` : ""}` });
      reset();
    } catch (error) {
      setNotice({ type: "error", text: error.response?.data?.error?.message || error.response?.data?.message || `${kind} failed. Check the entered IDs and your Admin access.` });
    } finally {
      setBusy("");
    }
  };

  const field = (label, value, onChange, options = {}) => (
    <label className="academic-field" key={options.name || label}>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} required={!options.optional}
        type={options.type || "text"} min={options.min} max={options.max} step={options.step}
        placeholder={options.placeholder || ""} />
      {options.help && <small>{options.help}</small>}
    </label>
  );

  return (
    <main className="academic-page">
      <header className="academic-topbar"><Link to="/admin/academic" className="academic-brand">Attendance System</Link><span>Admin workspace</span></header>
      <section className="academic-content">
        <div className="academic-heading"><div><p className="academic-eyebrow">ACADEMIC SETUP</p><h1>Manage courses and classes</h1><p>Create a course, open a section, then enroll students into it.</p></div><span className="academic-role">Admin</span></div>
        {notice && <div className={`academic-notice ${notice.type}`} role="status">{notice.text}</div>}

        <div className="academic-grid">
          <form className="academic-card" onSubmit={(event) => submit(event, "Course creation", () => createCourse({ ...course, semester: Number(course.semester) }), () => setCourse(initialCourse))}>
            <div className="academic-card-title"><span className="academic-step">01</span><div><h2>Create course</h2><p>Register a course in the catalog.</p></div></div>
            {field("Course code", course.code, (v) => setCourse({ ...course, code: v }), { placeholder: "CS101" })}
            {field("Course name", course.name, (v) => setCourse({ ...course, name: v }), { placeholder: "Introduction to Computing" })}
            {field("Department", course.department, (v) => setCourse({ ...course, department: v }), { placeholder: "CSE" })}
            {field("Semester", course.semester, (v) => setCourse({ ...course, semester: v }), { type: "number", min: 1, max: 12 })}
            <button className="academic-button" disabled={busy === "Course creation"}>{busy === "Course creation" ? "Creating…" : "Create course"}</button>
          </form>

          <form className="academic-card" onSubmit={(event) => submit(event, "Section creation", () => createSection({
            ...section, semester: Number(section.semester), latitude: Number(section.latitude), longitude: Number(section.longitude),
            geofenceRadiusMeters: Number(section.geofenceRadiusMeters), lecturers: section.lecturers.split(",").map((id) => id.trim()).filter(Boolean),
          }), () => setSection(initialSection))}>
            <div className="academic-card-title"><span className="academic-step">02</span><div><h2>Create section</h2><p>Set the class location and lecturer.</p></div></div>
            {field("Course ID", section.courseId, (v) => setSection({ ...section, courseId: v }), { placeholder: "24 character course ID" })}
            <div className="academic-form-row">{field("Section name", section.name, (v) => setSection({ ...section, name: v }), { placeholder: "A" })}{field("Semester", section.semester, (v) => setSection({ ...section, semester: v }), { type: "number", min: 1, max: 12 })}</div>
            <div className="academic-form-row">{field("Academic year", section.academicYear, (v) => setSection({ ...section, academicYear: v }), { placeholder: "2026-2027" })}{field("Room code", section.roomCode, (v) => setSection({ ...section, roomCode: v }), { placeholder: "B-204" })}</div>
            <div className="academic-form-row">{field("Latitude", section.latitude, (v) => setSection({ ...section, latitude: v }), { type: "number", min: -90, max: 90, step: "any" })}{field("Longitude", section.longitude, (v) => setSection({ ...section, longitude: v }), { type: "number", min: -180, max: 180, step: "any" })}</div>
            {field("Geofence radius (meters)", section.geofenceRadiusMeters, (v) => setSection({ ...section, geofenceRadiusMeters: v }), { type: "number", min: 5, max: 1000 })}
            {field("Lecturer user IDs", section.lecturers, (v) => setSection({ ...section, lecturers: v }), { optional: true, placeholder: "Comma-separated IDs", help: "Optional. Each ID must belong to an active Lecturer account." })}
            <button className="academic-button" disabled={busy === "Section creation"}>{busy === "Section creation" ? "Creating…" : "Create section"}</button>
          </form>

          <form className="academic-card academic-card-wide" onSubmit={(event) => submit(event, "Student enrollment", () => enrollStudent(enrollment), () => setEnrollment(initialEnrollment))}>
            <div className="academic-card-title"><span className="academic-step">03</span><div><h2>Enroll student</h2><p>Add an active student account to a section.</p></div></div>
            <div className="academic-form-row academic-enrollment-row">
              {field("Student user ID", enrollment.studentId, (v) => setEnrollment({ ...enrollment, studentId: v }), { placeholder: "24 character student ID" })}
              {field("Section ID", enrollment.sectionId, (v) => setEnrollment({ ...enrollment, sectionId: v }), { placeholder: "24 character section ID" })}
              {field("Roll number", enrollment.rollNumber, (v) => setEnrollment({ ...enrollment, rollNumber: v }), { placeholder: "24BCS001" })}
            </div>
            <button className="academic-button" disabled={busy === "Student enrollment"}>{busy === "Student enrollment" ? "Enrolling…" : "Enroll student"}</button>
          </form>
        </div>
        <p className="academic-footnote">The current API does not provide course, section, lecturer, or student search endpoints. Copy record IDs from your project’s approved admin/data setup workflow.</p>
      </section>
    </main>
  );
}

export default AdminAcademic;
